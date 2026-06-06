import "./styles.css";
import { Cesium, viewer } from "./viewer";
import { loadModels } from "./models";
import { getSelectedFloor, initSmartFloorCamera, openFloorProfessional, preloadFloor, showFloor } from "./floors";
import { getNavigableRoomNames, loadRooms } from "./rooms";
import { initializeCalendar } from "./calendar";
import {
  exitNavigation,
  installCorridorPointDebug,
  installIntermediatePointDebug,
  installStairPathDebug,
  startNavigation,
  setNavigationFloorSwitchHandler,
} from "./navigation";
import { clearCctvViewshed } from "./cameraShed/cctvViewshed";
import {
  bindCctvPanel,
  bindUiControls,
  installSceneInteractions,
  populateRoomDropdowns,
  setNavigationMessage,
  openBookingPanel,
  closeBookingPanel,
  getBookingPanelRoom,
  getBookingTimes,
  hideFloorSpinner,
  installMapDirectionsControl,
  showFloorSpinner,
  setEnterBuildingFloorSwitchCallback,
} from "./ui";
import { createBooking, getCurrentEvents, showToast } from "./booking";

// Guard: if WebGL context is lost (GPU OOM, driver reset), show spinner and reload
// instead of letting Cesium freeze with "Rendering has stopped."
function installContextLossGuard(): void {
  const canvas = viewer.scene.canvas;
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault(); // required so browser allows restoration
    showFloorSpinner("Display error — reloading…");
    setTimeout(() => window.location.reload(), 2500);
  }, false);
}

async function playOnboardingSplash(): Promise<void> {
  const splash = document.getElementById("onboardingSplash");
  if (!splash) return;

  splash.remove();
}

function requestIdleWork(callback: () => void, timeout = 2000): void {
  const requestIdle = (window as Window & {
    requestIdleCallback?: (handler: () => void, options?: { timeout?: number }) => number;
  }).requestIdleCallback;

  if (requestIdle) {
    requestIdle(callback, { timeout });
    return;
  }

  window.setTimeout(callback, timeout);
}

function preloadHeavyFloorsInBackground(): void {
  const floors = [3, 4];

  const preloadNext = async (): Promise<void> => {
    const floor = floors.shift();
    if (!floor) return;

    try {
      await preloadFloor(floor);
    } catch (error) {
      console.warn(`Background preload failed for floor ${floor}:`, error);
    }

    if (floors.length > 0) {
      requestIdleWork(() => { void preloadNext(); }, 2500);
    }
  };

  requestIdleWork(() => { void preloadNext(); }, 1500);
}

async function bootstrap(): Promise<void> {
  installContextLossGuard();
  setNavigationFloorSwitchHandler(openFloorProfessional);
  setEnterBuildingFloorSwitchCallback(openFloorProfessional);
  bindUiControls({
    showFloor: openFloorProfessional,
    preloadFloor,

    startNavigation: async () => {
      clearCctvViewshed();
      showFloorSpinner("Preparing navigation...");
      try {
        await startNavigation();
      } finally {
        hideFloorSpinner();
      }
    },

    exitNavigation,
  });
  bindCctvPanel();
  installMapDirectionsControl();
  setNavigationMessage("Loading building data...");

  const applySelectedFloor = (): void => showFloor(getSelectedFloor());
  const roomLoad = loadRooms().then(applySelectedFloor);
  const modelLoad = loadModels();

  await playOnboardingSplash();

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(77.133783, 28.670903, 81.51),
    orientation: {
      heading: Cesium.Math.toRadians(342.04),
      pitch: Cesium.Math.toRadians(-84.94),
      roll: 0,
    },
    duration: 1.5,
  });

  await Promise.all([modelLoad, roomLoad]);
  await installCorridorPointDebug();
  populateRoomDropdowns(getNavigableRoomNames());
  applySelectedFloor();
  initSmartFloorCamera();
  installStairPathDebug();
  await installIntermediatePointDebug();
  preloadHeavyFloorsInBackground();

  installSceneInteractions(getSelectedFloor, {
    onRoomClick: (roomName) => {
      openBookingPanel(roomName, getCurrentEvents());
    },
  });

  // ── Booking panel ── Book button
  document.getElementById("bookBtn")?.addEventListener("click", async () => {
    const roomName = getBookingPanelRoom();
    if (!roomName) return;

    const times = getBookingTimes();
    if (!times) {
      showToast("Please set start and end times", "error");
      return;
    }
    if (times.end <= times.start) {
      showToast("End time must be after start time", "error");
      return;
    }

    const btn = document.getElementById("bookBtn") as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = "Booking…"; }

    const result = await createBooking(roomName, times.start, times.end, getCurrentEvents());

    if (btn) { btn.disabled = false; btn.textContent = "Book Room"; }

    if (result.success) {
      showToast(`${roomName} booked successfully!`, "success");
      closeBookingPanel();
    } else {
      showToast(result.error ?? "Booking failed", "error");
    }
  });

  void initializeCalendar();
  setNavigationMessage("Choose rooms to start navigation.");

  // ── Hamburger Menu ──
  const hamburgerBtn = document.getElementById("hamburgerMenu") as HTMLButtonElement | null;
  const backdrop = document.getElementById("menuBackdrop") as HTMLElement | null;
  
  if (hamburgerBtn) {
    hamburgerBtn.addEventListener("click", () => {
      document.body.classList.toggle("side-panel-open");
      hamburgerBtn.classList.toggle("open");
    });
  }

  // Close menu when clicking backdrop
  if (backdrop) {
    backdrop.addEventListener("click", () => {
      document.body.classList.remove("side-panel-open");
      if (hamburgerBtn) hamburgerBtn.classList.remove("open");
    });
  }

  // Close menu when clicking outside
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const sidebar = document.querySelector(".left-sidebar");
    const isClickInsideSidebar = sidebar?.contains(target);
    const isClickOnHamburger = hamburgerBtn?.contains(target);
    
    if (!isClickInsideSidebar && !isClickOnHamburger) {
      document.body.classList.remove("side-panel-open");
      if (hamburgerBtn) hamburgerBtn.classList.remove("open");
    }
  });
}

bootstrap().catch((error) => {
  console.error("Application startup failed:", error);
  setNavigationMessage("Application startup failed. Check the console.");
});

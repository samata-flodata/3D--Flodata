import {
  Cesium,
  DEFAULT_AMBIENT_LIGHT,
  SECOND_FLOOR_COOL_AMBIENT_LIGHT,
  viewer
} from "./viewer";
import {
  ensureFloorModelLoaded,
  getActiveCctvModel,
  isSecondFloorLoadingPreviewActive,
  isThirdFloorLoadingPreviewActive,
  isCctvActive,
  isFloorModelLoaded,
  models,
  showSecondFloorWallPreview,
  showThirdFloorWallPreview,
  startSecondFloorLoadingPreview,
  startThirdFloorLoadingPreview,
  stopSecondFloorLoadingPreview,
  stopThirdFloorLoadingPreview
} from "./models";
import { geo2, geo3 } from "./rooms";
import { loadChairsForFloor, secondFloorChairs, thirdFloorChairs, type ChairModel } from "./chairs";
import { renderCameraControls } from "./ui";
import { updateNavigationVisibility } from "./navigation";
import { showToast } from "./booking";
import { clearCctvViewshed } from "./cameraShed/cctvViewshed";

let selectedFloor = 0;
let autoIndoorEnabled = true;
let mode: "OUTDOOR" | "INDOOR" = "OUTDOOR";
let indoorFloor: number | null = null;
let lastSwitchTime = 0;
let floorSwitchToken = 0;
const requestedChairFloors = new Set<3 | 4>();

const ENTER_INDOOR = 12;
const EXIT_OUTDOOR = 18;
const THIRD_FLOOR_BASE_PREVIEW_MS = 500;
const THIRD_FLOOR_WALL_PREVIEW_MIN_MS = 320;
const THIRD_FLOOR_CHAIR_DELAY_MS = 220;

export function getSelectedFloor(): number {
  return selectedFloor;
}

function setShow(target: { show: boolean } | null | undefined, show: boolean): void {
  if (target && target.show !== show) {
    target.show = show;
  }
}

function showLoadedChairIfSelected(chair: ChairModel): void {
  const shouldShow = chair.chairFloor === selectedFloor
    && !(chair.chairFloor === 3 && isSecondFloorLoadingPreviewActive())
    && !(chair.chairFloor === 4 && isThirdFloorLoadingPreviewActive());
  if (chair.show !== shouldShow) {
    chair.show = shouldShow;
    viewer.scene.requestRender();
  }
}

// Pure visibility-only update — no async triggers, no DOM rebuilds.
// Used by async callbacks so they don't re-enter showFloor and cause render storms.
function applyVisibility(floor: number): void {
  const secondFloorPreviewActive = floor === 3 && isSecondFloorLoadingPreviewActive();
  const thirdFloorPreviewActive = floor === 4 && isThirdFloorLoadingPreviewActive();
  const ambientLight = secondFloorPreviewActive ? DEFAULT_AMBIENT_LIGHT : floor === 3 ? SECOND_FLOOR_COOL_AMBIENT_LIGHT : DEFAULT_AMBIENT_LIGHT;
  if ((viewer.scene as any).ambientLightColor !== ambientLight) {
    (viewer.scene as any).ambientLightColor = ambientLight;
  }

  const sceneLight = viewer.scene.light as any;
  if (sceneLight && typeof sceneLight.intensity === "number") {
    sceneLight.intensity = floor > 0 ? (floor === 3 ? 5.0 : 4.6) : 4.4;
  }

  viewer.scene.postProcessStages.fxaa.enabled = true;

  for (let index = 0; index < viewer.dataSources.length; index += 1) {
    setShow(viewer.dataSources.get(index), false);
  }

  // Hide globe (map tiles) for indoor floors — shows clean black background
  const isIndoor = floor >= 2;
  viewer.scene.globe.show = !isIndoor;
  viewer.scene.backgroundColor = isIndoor
    ? Cesium.Color.BLACK
    : new Cesium.Color(0.1, 0.15, 0.25, 1.0);

  setShow(models.fullBuilding, floor === 0);
  setShow(models.outdoor, floor === 0);
  setShow(models.ground, floor === 1);
  setShow(models.first, floor === 2);
  setShow(models.second, floor === 3 && !secondFloorPreviewActive);
  setShow(models.third, floor === 4 && !thirdFloorPreviewActive);
  setShow(models.meetingRoom, floor === 4 && !thirdFloorPreviewActive);
  setShow(models.thirdFloorPiller, floor === 4 && !thirdFloorPreviewActive);
  if (!secondFloorPreviewActive) {
    setShow(models.secondFloorLoadingBase, false);
    setShow(models.secondFloorLoadingBaseWall, false);
  }
  if (!thirdFloorPreviewActive) {
    setShow(models.thirdFloorLoadingBase, false);
    setShow(models.thirdFloorLoadingBaseWall, false);
  }
  const activeCctv = getActiveCctvModel();
  models.cameras.forEach((camera) => {
    const shouldShow = (camera.cameraFloor === floor)
      && camera !== activeCctv
      && !(secondFloorPreviewActive && camera.cameraFloor === 3)
      && !(thirdFloorPreviewActive && camera.cameraFloor === 4);
    setShow(camera, shouldShow);
  });

  for (const chair of thirdFloorChairs) setShow(chair, floor === 4 && !thirdFloorPreviewActive);
  for (const chair of secondFloorChairs) setShow(chair, floor === 3 && !secondFloorPreviewActive);

  setShow(geo2, floor === 3 && !secondFloorPreviewActive);
  setShow(geo3, floor === 4 && !thirdFloorPreviewActive);

  updateNavigationVisibility(floor);
}

function requestChairFloor(floor: number): void {
  if (floor !== 3 && floor !== 4) return;
  if (requestedChairFloors.has(floor)) return;

  requestedChairFloors.add(floor);
  void loadChairsForFloor(floor, floor === 4 ? undefined : showLoadedChairIfSelected)
    .then(() => {
      // Use applyVisibility instead of showFloor to avoid recursive DOM rebuilds
      if (selectedFloor === floor) {
        applyVisibility(floor);
        viewer.scene.requestRender();
      }
    })
    .catch((error) => {
      requestedChairFloors.delete(floor);
      console.error(`Failed to load floor ${floor} chairs:`, error);
    });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function runStagedFloorLoad(
  floor: 3 | 4,
  token: number,
  options: {
    startPreview: () => void;
    showWallPreview: () => Promise<void>;
    stopPreview: () => void;
  }
): Promise<void> {
  options.startPreview();
  const floorLoadPromise = ensureFloorModelLoaded(floor);
  requestedChairFloors.add(floor);
  const chairLoadPromise = loadChairsForFloor(floor);
  applyVisibility(floor);
  viewer.scene.requestRender();
  await wait(THIRD_FLOOR_BASE_PREVIEW_MS);
  if (token !== floorSwitchToken || selectedFloor !== floor) {
    options.stopPreview();
    return;
  }

  await options.showWallPreview();
  await Promise.all([floorLoadPromise, wait(THIRD_FLOOR_WALL_PREVIEW_MIN_MS)]);
  if (token !== floorSwitchToken || selectedFloor !== floor) {
    options.stopPreview();
    return;
  }

  options.stopPreview();
  applyVisibility(floor);
  renderCameraControls(floor);
  viewer.scene.requestRender();
  await wait(THIRD_FLOOR_CHAIR_DELAY_MS);
  if (token !== floorSwitchToken || selectedFloor !== floor) return;

  await chairLoadPromise;
  if (token !== floorSwitchToken || selectedFloor !== floor) return;

  applyVisibility(floor);
  viewer.scene.requestRender();
}

export async function preloadFloor(floor: number): Promise<void> {
  if (floor <= 0) return;

  await ensureFloorModelLoaded(floor);

  if (floor === 3 || floor === 4) {
    requestedChairFloors.add(floor);
    await loadChairsForFloor(floor, floor === 4 ? undefined : showLoadedChairIfSelected);
  }
}

async function ensureFloorCompletelyLoaded(floor: number, token: number): Promise<void> {
  if (floor <= 0) return;

  if (floor === 3) {
    await runStagedFloorLoad(3, token, {
      startPreview: startSecondFloorLoadingPreview,
      showWallPreview: showSecondFloorWallPreview,
      stopPreview: stopSecondFloorLoadingPreview
    });
    return;
  }

  if (floor === 4) {
    await runStagedFloorLoad(4, token, {
      startPreview: startThirdFloorLoadingPreview,
      showWallPreview: showThirdFloorWallPreview,
      stopPreview: stopThirdFloorLoadingPreview
    });
    return;
  }

  await ensureFloorModelLoaded(floor);
  if (token !== floorSwitchToken || selectedFloor !== floor) return;

  if (floor === 3 || floor === 4) {
    requestedChairFloors.add(floor);
    await loadChairsForFloor(floor, floor === 4 ? undefined : showLoadedChairIfSelected);
    if (token !== floorSwitchToken || selectedFloor !== floor) return;
  }

  applyVisibility(floor);
  viewer.scene.requestRender();
}

export function showFloor(floor: number): void {
  if (isCctvActive()) {
    showToast("Exit camera view first to use this.", "error");
    return;
  }

  clearCctvViewshed();
  selectedFloor = floor;
  const token = ++floorSwitchToken;
  if (floor !== 3) {
    stopSecondFloorLoadingPreview();
  }
  if (floor !== 4) {
    stopThirdFloorLoadingPreview();
  }

  if (floor > 0 && !isFloorModelLoaded(floor)) {
    void ensureFloorCompletelyLoaded(floor, token)
      .catch((error) => console.error(`Failed to load floor ${floor}:`, error));
  } else {
    requestChairFloor(floor);
  }

  applyVisibility(floor);
  renderCameraControls(floor);
  viewer.scene.requestRender();
  // Update body classes so layout (eg. sign-in position) can respond to active floor.
  updateBodyFloorClass(floor);
}

// Returns a Promise so the UI can tie spinner lifetime to actual load completion.
export function openFloorProfessional(floorNumber: number): Promise<void> {
  if (isCctvActive()) {
    showToast("Exit camera view first to use this.", "error");
    return Promise.resolve();
  }

  if (
    floorNumber === selectedFloor
    && (floorNumber === 0 || isFloorModelLoaded(floorNumber))
    && !(floorNumber === 3 && isSecondFloorLoadingPreviewActive())
    && !(floorNumber === 4 && isThirdFloorLoadingPreviewActive())
  ) {
    return Promise.resolve();
  }

  clearCctvViewshed();
  if (typeof (viewer.camera as any).cancelFlight === "function") {
    (viewer.camera as any).cancelFlight();
  }

  autoIndoorEnabled = false;
  selectedFloor = floorNumber;
  const token = ++floorSwitchToken;
  if (floorNumber !== 3) {
    stopSecondFloorLoadingPreview();
  }
  if (floorNumber !== 4) {
    stopThirdFloorLoadingPreview();
  }

  if (floorNumber === 0) {
    mode = "OUTDOOR";
    indoorFloor = null;
  } else {
    mode = "INDOOR";
    indoorFloor = floorNumber;
  }

  applyVisibility(floorNumber);
  renderCameraControls(floorNumber);
  viewer.scene.requestRender();

  // Update body classes so layout (eg. sign-in position) can respond to active floor.
  updateBodyFloorClass(floorNumber);

  return (async () => {
    if (floorNumber === 3) {
      await runStagedFloorLoad(3, token, {
        startPreview: startSecondFloorLoadingPreview,
        showWallPreview: showSecondFloorWallPreview,
        stopPreview: stopSecondFloorLoadingPreview
      });
      return;
    }

    if (floorNumber === 4) {
      await runStagedFloorLoad(4, token, {
        startPreview: startThirdFloorLoadingPreview,
        showWallPreview: showThirdFloorWallPreview,
        stopPreview: stopThirdFloorLoadingPreview
      });
      return;
    }

    const chairPromise = (floorNumber === 3 || floorNumber === 4)
      ? (requestedChairFloors.add(floorNumber as 3 | 4), loadChairsForFloor(floorNumber))
      : Promise.resolve();

    await Promise.all([ensureFloorModelLoaded(floorNumber), chairPromise]);
    if (token !== floorSwitchToken || selectedFloor !== floorNumber) return;

    applyVisibility(floorNumber);
    viewer.scene.requestRender();
  })();
}

function updateBodyFloorClass(floor: number): void {
  try {
    const body = document.body;
    body.classList.toggle("floor-3-active", floor === 3);
    body.classList.toggle("floor-4-active", floor === 4);
  } catch (e) {
    // ignore in non-DOM environments
  }
}

function detectFloorFromScreenCenter(): number | null {
  const canvas = viewer.scene.canvas;
  const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
  const picked = viewer.scene.pick(center);
  const primitive = picked?.primitive;

  if (primitive === models.ground) return 1;
  if (primitive === models.first) return 2;
  if (primitive === models.second) return 3;
  if (primitive === models.third) return 4;
  return null;
}

export function initSmartFloorCamera(): void {
  viewer.camera.changed.addEventListener(() => {
    if (isCctvActive()) return;
    if (!autoIndoorEnabled) return;

    const height = viewer.camera.positionCartographic.height;
    if (height >= ENTER_INDOOR) {
      if (selectedFloor === 0) showFloor(0);
      return;
    }

    if (mode === "INDOOR") {
      const now = Date.now();
      if (now - lastSwitchTime < 300) return;
      if (indoorFloor) showFloor(indoorFloor);
      if (height > EXIT_OUTDOOR) {
        mode = "OUTDOOR";
        indoorFloor = null;
        showFloor(0);
        lastSwitchTime = now;
      }
    }
  });

  viewer.camera.moveEnd.addEventListener(() => {
    if (isCctvActive()) return;
    if (!autoIndoorEnabled) return;

    const height = viewer.camera.positionCartographic.height;
    if (height >= ENTER_INDOOR || mode === "INDOOR") return;

    const now = Date.now();
    if (now - lastSwitchTime < 300) return;

    if (models.fullBuilding) models.fullBuilding.show = false;
    if (models.ground) models.ground.show = true;
    if (models.first) models.first.show = true;
    if (models.second) models.second.show = true;
    if (models.third) models.third.show = true;

    const detectedFloor = detectFloorFromScreenCenter();
    if (detectedFloor) {
      indoorFloor = detectedFloor;
      mode = "INDOOR";
      showFloor(detectedFloor);
      lastSwitchTime = now;
    } else {
      showFloor(0);
    }
  });
}

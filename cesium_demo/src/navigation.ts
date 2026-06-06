import {
  Cesium,
  ALT_2ND,
  ALT_3RD,
  viewer
} from "./viewer";
import { geo2, geo3, geoJsonUrl, normalizeRoomName } from "./rooms";
import { setNavigationAllowedFloors, setNavigationMessage, updateNavigationUI, disableCameraControls, enableCameraControls, showFloorSpinner, hideFloorSpinner, updateNavigationHud, hideNavigationHud, clearMapRoute, hideTooltip, type NavigationHudState } from "./ui";
import { ensureFloorModelLoaded } from "./models";
import intermediatePointUrl from "./intermidiate_point.geojson?url";

type DoorFeature = {
  properties: { room_name: string };
  geometry: {
    type: "Point" | "Polygon" | "MultiPolygon";
    coordinates: any;
  };
};

type GraphNode = {
  pos: Cesium.Cartesian3;
  lon: number;
  lat: number;
  id: string | number;
  edges: GraphEdge[];
};

type GraphEdge = {
  node: GraphNode;
  w: number;
};

type CorridorDebugFeature = {
  type: "Feature";
  properties?: Record<string, unknown>;
  geometry?: {
    type: string;
    coordinates: [number, number];
  };
};

type CorridorDebugFileState = {
  fileName: string;
  graph: GraphNode[];
  features: CorridorDebugFeature[];
};

type CorridorDebugPointState = {
  entity: Cesium.Entity;
  node: GraphNode;
  floor: number;
  index: number;
};

type IntermediatePointFeature = {
  type: "Feature";
  properties?: {
    lat?: number;
    long?: number;
    id_no?: string;
    [key: string]: unknown;
  };
  geometry?: {
    type: string;
    coordinates: [number, number];
  };
};

type IntermediatePointState = {
  entity: Cesium.Entity;
  feature: IntermediatePointFeature;
  index: number;
  idNo: number;
};

type ResolvedRoomSelection = {
  displayName: string;
  roomName: string;
  floor: number;
};

const doorPositions = new Map<string, Cesium.Cartesian3>();
let centerlineGraph2: GraphNode[] | null = null;
let centerlineGraph3: GraphNode[] | null = null;
let navDataReady = false;
let currentVisibleFloor = 0;
let corridorDebugLoaded = false;
const corridorDebugEntities: Array<{ entity: Cesium.Entity; floor: number; kind: "point" | "edge" }> = [];
const corridorDebugFiles = new Map<number, CorridorDebugFileState>();
const corridorDebugPoints = new Map<string, CorridorDebugPointState>();
const stairDebugEntities: Cesium.Entity[] = [];
const stairDebugPoints = new Map<string, { index: number; entity: Cesium.Entity }>();
const intermediateDebugEntities: Cesium.Entity[] = [];
const intermediateDebugPoints = new Map<string, IntermediatePointState>();
let intermediateDebugFeatures: IntermediatePointFeature[] = [];
let corridorDebugDragHandler: Cesium.ScreenSpaceEventHandler | null = null;
let stairDebugDragHandler: Cesium.ScreenSpaceEventHandler | null = null;
let intermediateDebugDragHandler: Cesium.ScreenSpaceEventHandler | null = null;
let selectedCorridorDebugPoint: CorridorDebugPointState | null = null;
let selectedStairDebugPoint: { index: number; entity: Cesium.Entity } | null = null;
let selectedIntermediateDebugPoint: IntermediatePointState | null = null;

const routeArrowCollectionA = viewer.scene.primitives.add(new Cesium.BillboardCollection());
const routeArrowCollectionB = viewer.scene.primitives.add(new Cesium.BillboardCollection());
const routeBubbleCollectionA = viewer.scene.primitives.add(new Cesium.BillboardCollection());
const routeBubbleCollectionB = viewer.scene.primitives.add(new Cesium.BillboardCollection());
const routeGlowCollectionA = viewer.scene.primitives.add(new Cesium.BillboardCollection());
const routeGlowCollectionB = viewer.scene.primitives.add(new Cesium.BillboardCollection());

const ROAD_VIEW_EYE_HEIGHT_METERS = 1.45;
const ROAD_VIEW_LOOK_HEIGHT_METERS = 0.55;
const ROAD_VIEW_BACK_OFFSET_METERS = 0.9;
const ROAD_VIEW_FOV_DEGREES = 58;
const ROAD_VIEW_LOOK_AHEAD_STEPS = 1;
const LIVE_NAVIGATION_STEP_MS = 420;

let liveNavTimer: number | null = null;
let liveNavPath: Cesium.Cartesian3[] = [];
let liveNavFloorByIndex: number[] = [];
let liveNavIndex = 0;
let liveNavFirstSegmentLength = 0;
let liveNavStairStartIndex = -1;
let liveNavStairEndIndex = -1;
let liveNavActiveFloor: number | null = null;
let liveNavPendingFloor: number | null = null;
let liveNavDestinationName = "";
let liveNavDestinationRoomName = "";
let liveNavDestinationFloor: number | null = null;
let navigationFloorSwitchHandler: ((floor: number) => void | Promise<void>) | null = null;
let routeAnimRemove: (() => void) | null = null;
let routeAnimStart = 0;
let routeDotTValuesA: number[] = [];
let routeDotTValuesB: number[] = [];
let routeBubbleBillboardsA: Cesium.Billboard[] = [];
let routeBubbleBillboardsB: Cesium.Billboard[] = [];
let routeBubbleDensityStride = 1;
let arrivalHudHideTimer: number | null = null;

const MAX_CORRIDOR_EDGE_METERS = 8.0;
const MAX_CORRIDOR_NEAREST_NEIGHBORS = 4;
const CORRIDOR_DEBUG_PARAM = "corridorDebug";
const STAIR_DEBUG_PARAM = "stairDebug";
const INTERMEDIATE_DEBUG_PARAM = "intermediateDebug";
const INTERMIDIATE_DEBUG_PARAM = "intermidiateDebug";
const CORRIDOR_DEBUG_HEIGHT_OFFSET = 2.8;
const STAIR_DEBUG_HEIGHT_OFFSET = 4.0;
const INTERMEDIATE_DEBUG_HEIGHT_OFFSET = 4.4;
const SECOND_FLOOR_PANTRY_EMPLOYEE_SIDE_DOOR = Cesium.Cartesian3.fromDegrees(
  77.13362535043548,
  28.670995911296629,
  ALT_2ND + 0.1
);
const THIRD_FLOOR_PANTRY_NEAR_CONFERENCE_DOOR = Cesium.Cartesian3.fromDegrees(
  77.13371705946003,
  28.67095703850098,
  ALT_3RD + 0.1
);
const THIRD_FLOOR_PANTRY_LOWER_DOOR = Cesium.Cartesian3.fromDegrees(
  77.13372663090223,
  28.67092052705272,
  ALT_3RD + 0.1
);

const ROUTE_BUBBLE_SVG = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 56 56">
  <circle cx="28" cy="28" r="25" fill="none" stroke="rgba(255,255,255,0.92)" stroke-width="5"/>
  <circle cx="28" cy="28" r="18" fill="#00CCFF"/>
  <circle cx="28" cy="28" r="9" fill="white" fill-opacity="0.65"/>
</svg>
`)}`;

const ROUTE_GLOW_SVG = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="140" height="140" viewBox="0 0 140 140">
  <defs>
    <radialGradient id="g" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.95"/>
      <stop offset="20%" stop-color="#00DDFF" stop-opacity="0.80"/>
      <stop offset="55%" stop-color="#0066FF" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#0044FF" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <circle cx="70" cy="70" r="65" fill="url(#g)"/>
</svg>
`)}`;

const DESTINATION_CAMERA_PRESETS: Record<string, {
  lon: number;
  lat: number;
  height: number;
  heading: number;
  pitch: number;
  roll: number;
  fov: number;
}> = {
  "3|manthan": {
    lon: 77.13375476,
    lat: 28.67090875,
    height: 11.16,
    heading: 329.38,
    pitch: -47.94,
    roll: 0,
    fov: 58
  },
  "4|conference room": {
    lon: 77.13363249,
    lat: 28.67093738,
    height: 16.19,
    heading: 326.63,
    pitch: -60.56,
    roll: 0,
    fov: 58
  },
  "3|dojo": {
    lon: 77.13365024541,
    lat: 28.67095863016,
    height: 8.1784,
    heading: 149.2359,
    pitch: -32.1258,
    roll: 0,
    fov: 58
  },
  "3|eureka": {
    lon: 77.13369630647,
    lat: 28.67097179017,
    height: 11.8672,
    heading: 63.91,
    pitch: -74.1073,
    roll: 0.0001,
    fov: 58
  },
  "4|library": {
    lon: 77.13367953877,
    lat: 28.67086780995,
    height: 12.2209,
    heading: 332.3004,
    pitch: -34.9491,
    roll: 0,
    fov: 58
  },
  "4|meeting room": {
    lon: 77.13367129265,
    lat: 28.67101945937,
    height: 13.5826,
    heading: 322.9066,
    pitch: -77.6764,
    roll: 0,
    fov: 58
  },
  "3|pantry": {
    lon: 77.13359931811,
    lat: 28.67099906596,
    height: 10.4152,
    heading: 151.8243,
    pitch: -77.5895,
    roll: 0.0001,
    fov: 58
  },
  "4|pantry": {
    lon: 77.13372773723,
    lat: 28.67093722174,
    height: 15.9639,
    heading: 55.0383,
    pitch: -81.3355,
    roll: 0.0001,
    fov: 58
  },
  "3|admin": {
    lon: 77.13367876163,
    lat: 28.67090258073,
    height: 9.9028,
    heading: 226.3380,
    pitch: -61.5925,
    roll: 0,
    fov: 58
  },
  "3|ug's cabin": {
    lon: 77.13366237738,
    lat: 28.67100804682,
    height: 11.0537,
    heading: 59.4988,
    pitch: -58.4382,
    roll: 0,
    fov: 58
  },
  "3|vg's cabin": {
    lon: 77.13360662650,
    lat: 28.67096091377,
    height: 10.6954,
    heading: 63.7303,
    pitch: -77.9384,
    roll: 0.0002,
    fov: 58
  }
};

const CUSTOM_STAIR_PATH = [
  { lon: 77.13369487589452, lat: 28.67089514560174 },
  { lon: 77.13369762958561, lat: 28.670896829794504 },
  { lon: 77.13370575798822, lat: 28.670902046216586 },
  { lon: 77.13368821772951, lat: 28.670936267563533 },
  { lon: 77.13368355420981, lat: 28.67093314152187 },
  { lon: 77.13369675630433, lat: 28.670908889590613 }
];

viewer.camera.changed.addEventListener(() => {
  applyRouteBubbleDensity();
});

function clearRouteEntities(): void {
  viewer.entities.removeById("debugDoorStart");
  viewer.entities.removeById("debugDoorEnd");
  viewer.entities.removeById("debugCorridorStart");
  viewer.entities.removeById("debugCorridorEnd");
  viewer.entities.removeById("navigationLineA");
  viewer.entities.removeById("navigationLineB");
  viewer.entities.removeById("stairsLine");
  viewer.entities.removeById("startMarker");
  viewer.entities.removeById("endMarker");
  viewer.entities.removeById("navMarkerDot");
  viewer.entities.removeById("liveNavigationMarker");
  routeArrowCollectionA.removeAll();
  routeArrowCollectionB.removeAll();
  routeBubbleCollectionA.removeAll();
  routeBubbleCollectionB.removeAll();
  routeBubbleBillboardsA = [];
  routeBubbleBillboardsB = [];
  routeDotTValuesA = [];
  routeDotTValuesB = [];
  routeBubbleDensityStride = 1;
  routeGlowCollectionA.removeAll();
  routeGlowCollectionB.removeAll();

  if (routeAnimRemove !== null) {
    routeAnimRemove();
    routeAnimRemove = null;
  }
}

function stopLiveNavigationMarker(): void {
  if (liveNavTimer !== null) {
    window.clearInterval(liveNavTimer);
    liveNavTimer = null;
  }
  liveNavPath = [];
  liveNavFloorByIndex = [];
  liveNavIndex = 0;
  liveNavFirstSegmentLength = 0;
  liveNavStairStartIndex = -1;
  liveNavStairEndIndex = -1;
  liveNavActiveFloor = null;
  liveNavPendingFloor = null;
  liveNavDestinationName = "";
  liveNavDestinationRoomName = "";
  liveNavDestinationFloor = null;
  viewer.entities.removeById("liveNavigationMarker");
  hideNavigationHud();
}

function requestLiveNavigationFloor(floor: number | undefined): void {
  if (!floor || floor === liveNavActiveFloor || floor === liveNavPendingFloor) return;

  liveNavPendingFloor = floor;
  void Promise.resolve(navigationFloorSwitchHandler?.(floor))
    .then(() => {
      liveNavActiveFloor = floor;
    })
    .catch((error) => {
      console.error(`Failed to switch navigation floor to ${floor}:`, error);
    })
    .finally(() => {
      if (liveNavPendingFloor === floor) {
        liveNavPendingFloor = null;
      }
    });
}

function offsetAlongLocalUp(position: Cesium.Cartesian3, meters: number): Cesium.Cartesian3 {
  const up = Cesium.Cartesian3.normalize(position, new Cesium.Cartesian3());
  return Cesium.Cartesian3.add(
    position,
    Cesium.Cartesian3.multiplyByScalar(up, meters, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  );
}

function applyRoadNavigationView(index: number, smooth = true): void {
  if (liveNavPath.length < 2) return;

  const current = liveNavPath[index];
  const next = liveNavPath[Math.min(index + ROAD_VIEW_LOOK_AHEAD_STEPS, liveNavPath.length - 1)] ?? current;
  const previous = liveNavPath[Math.max(index - 1, 0)] ?? current;
  const forwardSource = Cesium.Cartesian3.distance(current, next) > 0.05 ? next : previous;
  const forward = Cesium.Cartesian3.subtract(forwardSource, current, new Cesium.Cartesian3());
  if (Cesium.Cartesian3.magnitudeSquared(forward) < 0.000001) return;

  Cesium.Cartesian3.normalize(forward, forward);
  const localUp = Cesium.Cartesian3.normalize(current, new Cesium.Cartesian3());
  const eyeBase = offsetAlongLocalUp(current, ROAD_VIEW_EYE_HEIGHT_METERS);
  const eye = Cesium.Cartesian3.subtract(
    eyeBase,
    Cesium.Cartesian3.multiplyByScalar(forward, ROAD_VIEW_BACK_OFFSET_METERS, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  );
  const target = offsetAlongLocalUp(forwardSource, ROAD_VIEW_LOOK_HEIGHT_METERS);
  const direction = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(target, eye, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  );
  const right = Cesium.Cartesian3.cross(direction, localUp, new Cesium.Cartesian3());
  if (Cesium.Cartesian3.magnitudeSquared(right) < 0.000001) return;

  Cesium.Cartesian3.normalize(right, right);
  const up = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(right, direction, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  );

  if (viewer.camera.frustum instanceof Cesium.PerspectiveFrustum) {
    viewer.camera.frustum.fov = Cesium.Math.toRadians(ROAD_VIEW_FOV_DEGREES);
  }

  if (!smooth) {
    viewer.camera.setView({
      destination: eye,
      orientation: { direction, up }
    });
    return;
  }

  if (typeof (viewer.camera as any).cancelFlight === "function") {
    (viewer.camera as any).cancelFlight();
  }
  viewer.camera.flyTo({
    destination: eye,
    orientation: { direction, up },
    duration: 0.18,
    easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
  });
}

function remainingPathDistance(path: Cesium.Cartesian3[], fromIndex: number): number {
  let total = 0;
  for (let index = Math.max(1, fromIndex + 1); index < path.length; index += 1) {
    total += Cesium.Cartesian3.distance(path[index - 1], path[index]);
  }
  return total;
}

function liveNavigationHudState(index: number): NavigationHudState {
  const floor = liveNavFloorByIndex[index];
  const nextFloor = liveNavFloorByIndex[Math.min(index + 1, liveNavFloorByIndex.length - 1)];
  const remaining = remainingPathDistance(liveNavPath, index);
  const contextBase = liveNavDestinationName
    ? `${floorLabel(floor)} to ${liveNavDestinationName}`
    : floorLabel(floor);

  if (index >= liveNavPath.length - 1) {
    return {
      icon: "arrive",
      instruction: "Arrived",
      context: contextBase,
      distanceMeters: 0
    };
  }

  if (index >= liveNavStairStartIndex && index <= liveNavStairEndIndex) {
    const targetFloor = activeNavToFloor ?? nextFloor;
    return {
      icon: "stairs",
      instruction: "Use stairs",
      context: `Be careful - move to ${floorLabel(targetFloor)}`,
      distanceMeters: remaining
    };
  }

  if (nextFloor !== floor) {
    return {
      icon: "stairs",
      instruction: "Stairs ahead",
      context: `Be careful - move to ${floorLabel(nextFloor)}`,
      distanceMeters: remaining
    };
  }

  if (index < 1 || index >= liveNavPath.length - 2) {
    return {
      icon: "forward",
      instruction: "Forward",
      context: contextBase,
      distanceMeters: remaining
    };
  }

  const currentHeading = headingENU(liveNavPath[index - 1], liveNavPath[index]);
  const nextHeading = headingENU(liveNavPath[index], liveNavPath[index + 1]);
  let angleDiff = nextHeading - currentHeading;
  while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
  while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;

  if (Math.abs(angleDiff) < 0.45) {
    return {
      icon: "forward",
      instruction: "Forward",
      context: contextBase,
      distanceMeters: remaining
    };
  }

  const turnLeft = angleDiff > 0;
  return {
    icon: turnLeft ? "left" : "right",
    instruction: `Turn ${turnLeft ? "left" : "right"}`,
    context: `Next: ${contextBase}`,
    distanceMeters: remaining
  };
}

function updateLiveNavigationHud(index: number): void {
  updateNavigationHud(liveNavigationHudState(index));
}

function showArrivalWelcomeHud(): void {
  if (arrivalHudHideTimer !== null) {
    window.clearTimeout(arrivalHudHideTimer);
    arrivalHudHideTimer = null;
  }

  updateNavigationHud({
    icon: "arrive",
    instruction: `Welcome to ${liveNavDestinationRoomName || liveNavDestinationName || "destination"} 🎉`,
    context: "You have arrived",
    distanceMeters: 0
  });

  arrivalHudHideTimer = window.setTimeout(() => {
    hideNavigationHud();
    arrivalHudHideTimer = null;
  }, 3000);
}

function isRouteBubbleAhead(segment: "A" | "B", index: number): boolean {
  if (liveNavPath.length === 0) return true;
  if (segment === "A") return index > liveNavIndex;
  return liveNavIndex < liveNavFirstSegmentLength || index > liveNavIndex - liveNavFirstSegmentLength;
}

function updateCompletedRouteDots(): void {
  routeBubbleBillboardsA.forEach((billboard, index) => {
    billboard.show = isRouteBubbleAhead("A", index) && (index % routeBubbleDensityStride === 0 || index === routeBubbleBillboardsA.length - 1);
  });
  routeBubbleBillboardsB.forEach((billboard, index) => {
    billboard.show = isRouteBubbleAhead("B", index) && (index % routeBubbleDensityStride === 0 || index === routeBubbleBillboardsB.length - 1);
  });
}

function getRoomViewEntity(roomName: string, floor: number): Cesium.Entity | undefined {
  const dataSource = floor === 3 ? geo2 : geo3;
  const target = normalizeRoomName(roomName);
  return dataSource?.entities.values.find((entity) => normalizeRoomName(getEntityRoomName(entity)) === target);
}

function roomBoundingSphere(entity: Cesium.Entity, floor: number): Cesium.BoundingSphere | null {
  const hierarchy = entity.polygon?.hierarchy?.getValue(Cesium.JulianDate.now());
  const positions = hierarchy?.positions ?? [];
  if (positions.length > 0) {
    return Cesium.BoundingSphere.fromPoints(positions);
  }

  const position = entity.position?.getValue(Cesium.JulianDate.now()) ?? getRoomFallbackPosition(
    liveNavDestinationRoomName,
    floor
  );
  return position ? new Cesium.BoundingSphere(position, 4) : null;
}


async function focusDestinationRoomView(): Promise<void> {
  if (!liveNavDestinationRoomName || !liveNavDestinationFloor) return;

  await Promise.resolve(navigationFloorSwitchHandler?.(liveNavDestinationFloor));

  const entity = getRoomViewEntity(liveNavDestinationRoomName, liveNavDestinationFloor);
  const sphere = entity ? roomBoundingSphere(entity, liveNavDestinationFloor) : null;
  if (!sphere) return;

  if (typeof (viewer.camera as any).cancelFlight === "function") {
    (viewer.camera as any).cancelFlight();
  }

  const preset = DESTINATION_CAMERA_PRESETS[`${liveNavDestinationFloor}|${normalizeRoomName(liveNavDestinationRoomName)}`];
  if (preset) {
    if (viewer.camera.frustum instanceof Cesium.PerspectiveFrustum) {
      viewer.camera.frustum.fov = Cesium.Math.toRadians(preset.fov);
    }

    await new Promise<void>((resolve) => {
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(preset.lon, preset.lat, preset.height),
        orientation: {
          heading: Cesium.Math.toRadians(preset.heading),
          pitch: Cesium.Math.toRadians(preset.pitch),
          roll: Cesium.Math.toRadians(preset.roll)
        },
        duration: 1.2,
        easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
        complete: () => {
          viewer.scene.requestRender();
          resolve();
        },
        cancel: () => {
          viewer.scene.requestRender();
          resolve();
        }
      });
    });
    return;
  }

  await new Promise<void>((resolve) => {
    viewer.camera.flyToBoundingSphere(sphere, {
      duration: 1.2,
      offset: new Cesium.HeadingPitchRange(
        Cesium.Math.toRadians(18),
        Cesium.Math.toRadians(-67),
        Math.max(sphere.radius * 2.8, 11)
      ),
      complete: () => {
        viewer.scene.requestRender();
        resolve();
      },
      cancel: () => {
        viewer.scene.requestRender();
        resolve();
      }
    });
  });
}

async function finishLiveNavigation(): Promise<void> {
  if (liveNavTimer !== null) {
    window.clearInterval(liveNavTimer);
    liveNavTimer = null;
  }

  clearRouteEntities();
  clearMapRoute();
  hideTooltip();
  showArrivalWelcomeHud();
  activeNavFromFloor = null;
  activeNavToFloor = null;
  setNavigationAllowedFloors(null);
  enableCameraControls();
  await focusDestinationRoomView();
  viewer.scene.requestRender();
}

function startLiveNavigationMarker(
  path: Cesium.Cartesian3[],
  floorByIndex: number[],
  destinationName: string,
  destinationRoomName: string,
  destinationFloor: number,
  firstSegmentLength: number,
  stairRange?: { startIndex: number; endIndex: number }
): void {
  stopLiveNavigationMarker();

  if (path.length < 2) return;

  liveNavPath = path;
  liveNavFloorByIndex = floorByIndex;
  liveNavDestinationName = destinationName;
  liveNavDestinationRoomName = destinationRoomName;
  liveNavDestinationFloor = destinationFloor;
  liveNavFirstSegmentLength = firstSegmentLength;
  liveNavStairStartIndex = stairRange?.startIndex ?? -1;
  liveNavStairEndIndex = stairRange?.endIndex ?? -1;
  liveNavIndex = 0;
  requestLiveNavigationFloor(liveNavFloorByIndex[0]);
  applyRoadNavigationView(0, false);
  updateLiveNavigationHud(0);

  viewer.entities.add({
    id: "liveNavigationMarker",
    position: path[0],
    point: {
      pixelSize: new Cesium.CallbackProperty(() => 17 + 5 * Math.abs(Math.sin(performance.now() * 0.005)), false),
      color: Cesium.Color.fromCssColorString("#00CCFF"),
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 4,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });

  liveNavTimer = window.setInterval(() => {
    const marker = viewer.entities.getById("liveNavigationMarker");
    if (!marker || liveNavPath.length === 0) return;

    if (liveNavIndex >= liveNavPath.length - 1) {
      void finishLiveNavigation();
      return;
    }

    liveNavIndex += 1;
    marker.position = new Cesium.ConstantPositionProperty(liveNavPath[liveNavIndex]);
    requestLiveNavigationFloor(liveNavFloorByIndex[liveNavIndex]);
    applyRoadNavigationView(liveNavIndex);
    updateLiveNavigationHud(liveNavIndex);
    updateCompletedRouteDots();

    viewer.scene.requestRender();
  }, LIVE_NAVIGATION_STEP_MS);
}

export function setNavigationFloorSwitchHandler(
  handler: ((floor: number) => void | Promise<void>) | null
): void {
  navigationFloorSwitchHandler = handler;
}

export let activeNavFromFloor: number | null = null;
export let activeNavToFloor: number | null = null;

export function exitNavigation(): void {
  if (arrivalHudHideTimer !== null) {
    window.clearTimeout(arrivalHudHideTimer);
    arrivalHudHideTimer = null;
  }
  stopLiveNavigationMarker();
  clearRouteEntities();
  activeNavFromFloor = null;
  activeNavToFloor = null;
  setNavigationAllowedFloors(null);
  enableCameraControls();
  setNavigationMessage("Choose rooms to start navigation.");
  viewer.scene.requestRender();
}

export function updateNavigationVisibility(activeFloor: number): void {
  currentVisibleFloor = activeFloor;

  const showA = activeFloor === activeNavFromFloor;
  const showB = activeFloor === activeNavToFloor;
  const showStairs = activeFloor === activeNavFromFloor || activeFloor === activeNavToFloor;
  
  const lineA = viewer.entities.getById("navigationLineA");
  if (lineA) lineA.show = false;

  const lineB = viewer.entities.getById("navigationLineB");
  if (lineB) lineB.show = false;

  const stairs = viewer.entities.getById("stairsLine");
  if (stairs) stairs.show = false;
  
  const dot = viewer.entities.getById("navMarkerDot");
  if (dot) dot.show = showStairs;

  const liveMarker = viewer.entities.getById("liveNavigationMarker");
  if (liveMarker) liveMarker.show = showStairs;

  const startMarker = viewer.entities.getById("startMarker");
  if (startMarker) startMarker.show = showA;

  const endMarker = viewer.entities.getById("endMarker");
  if (endMarker) endMarker.show = showB;
  
  routeArrowCollectionA.show = false;
  routeArrowCollectionB.show = false;
  routeBubbleCollectionA.show = showA;
  routeBubbleCollectionB.show = showB;
  routeGlowCollectionA.show = showA;
  routeGlowCollectionB.show = showB;
  corridorDebugEntities.forEach(({ entity, floor }) => {
    entity.show = activeFloor === 0 || activeFloor === floor;
  });
  stairDebugEntities.forEach((entity) => {
    entity.show = stairDebugEnabled();
  });
  intermediateDebugEntities.forEach((entity) => {
    entity.show = intermediateDebugEnabled();
  });
  applyRouteBubbleDensity(true);

  if (activeNavFromFloor && activeNavToFloor) {
    let message = "Continue navigation on this floor.";
    if (activeNavFromFloor !== activeNavToFloor && activeFloor === activeNavFromFloor) {
      message = "Proceed to stairs, then switch floor to continue.";
    }
    setNavigationMessage(message, false);
  }
}

function corridorDebugEnabled(): boolean {
  const params = new URLSearchParams(window.location.search);
  const value = params.get(CORRIDOR_DEBUG_PARAM);
  return value === "1" || value === "true" || value === "points" || value === "edit";
}

function corridorDebugEditable(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get(CORRIDOR_DEBUG_PARAM) === "edit";
}

function corridorDebugAltitude(floor: number): number {
  return (floor === 3 ? ALT_2ND : ALT_3RD) + CORRIDOR_DEBUG_HEIGHT_OFFSET;
}

function corridorDebugPosition(node: GraphNode, floor: number): Cesium.Cartesian3 {
  return Cesium.Cartesian3.fromDegrees(node.lon, node.lat, corridorDebugAltitude(floor));
}

function setCorridorDebugNodePosition(point: CorridorDebugPointState, lon: number, lat: number): void {
  const routeAltitude = point.floor === 3 ? ALT_2ND : ALT_3RD;
  point.node.lon = lon;
  point.node.lat = lat;
  point.node.pos = Cesium.Cartesian3.fromDegrees(lon, lat, routeAltitude + 0.1);
  point.entity.position = new Cesium.ConstantPositionProperty(corridorDebugPosition(point.node, point.floor));

  const fileState = corridorDebugFiles.get(point.floor);
  const feature = fileState?.features[point.index];
  if (feature?.geometry?.type === "Point") {
    feature.geometry.coordinates = [lon, lat];
    if (feature.properties) {
      feature.properties.Longitude = lon;
      feature.properties.Latitude = lat;
    }
  }

  if (fileState) {
    rebuildCenterlineGraphEdges(fileState.graph);
    redrawCorridorDebugEdges(point.floor);
  }
}

function pickCorridorDebugLonLat(position: Cesium.Cartesian2): { lon: number; lat: number } | null {
  const cartesian = viewer.camera.pickEllipsoid(position, viewer.scene.globe.ellipsoid);
  if (!cartesian) return null;

  const cartographic = Cesium.Cartographic.fromCartesian(cartesian);
  return {
    lon: Cesium.Math.toDegrees(cartographic.longitude),
    lat: Cesium.Math.toDegrees(cartographic.latitude),
  };
}

function exportCorridorDebugGeoJSON(): void {
  corridorDebugFiles.forEach((fileState) => {
    const geoJson = {
      type: "FeatureCollection",
      name: fileState.fileName.replace(".geojson", ""),
      features: fileState.features,
    };
    console.info(`Updated ${fileState.fileName}`, JSON.stringify(geoJson, null, 2));
  });
}

function installCorridorDebugEditor(): void {
  if (!corridorDebugEditable() || corridorDebugDragHandler) return;

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  corridorDebugDragHandler = handler;

  handler.setInputAction((event: { position: Cesium.Cartesian2 }) => {
    const picked = viewer.scene.pick(event.position);
    const entity = picked?.id instanceof Cesium.Entity ? picked.id : null;
    const point = entity ? corridorDebugPoints.get(String(entity.id)) : null;
    if (!point) return;

    selectedCorridorDebugPoint = point;
    viewer.scene.screenSpaceCameraController.enableInputs = false;
  }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

  handler.setInputAction((event: { endPosition: Cesium.Cartesian2 }) => {
    if (!selectedCorridorDebugPoint) return;

    const picked = pickCorridorDebugLonLat(event.endPosition);
    if (!picked) return;

    setCorridorDebugNodePosition(selectedCorridorDebugPoint, picked.lon, picked.lat);
    viewer.scene.requestRender();
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  handler.setInputAction(() => {
    if (!selectedCorridorDebugPoint) return;

    selectedCorridorDebugPoint = null;
    viewer.scene.screenSpaceCameraController.enableInputs = true;
    exportCorridorDebugGeoJSON();
  }, Cesium.ScreenSpaceEventType.LEFT_UP);

  window.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() === "e") {
      exportCorridorDebugGeoJSON();
    }
  });
}

function addCorridorDebugGraph(graph: GraphNode[], floor: number, fileName: string): void {
  const color = floor === 3
    ? Cesium.Color.fromCssColorString("#00D5FF")
    : Cesium.Color.fromCssColorString("#FFB000");
  const floorLabel = floor === 3 ? "2F" : "3F";

  graph.forEach((node, index) => {
    const pointEntity = viewer.entities.add({
      id: `debugCorridorPoint-${floor}-${index}`,
      position: corridorDebugPosition(node, floor),
      point: {
        pixelSize: corridorDebugEditable() ? 17 : 14,
        color,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: `${floorLabel}-${node.id}`,
        font: "13px sans-serif",
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -20),
        showBackground: true,
        backgroundColor: Cesium.Color.BLACK.withAlpha(0.55),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    corridorDebugEntities.push({ entity: pointEntity, floor, kind: "point" });
    corridorDebugPoints.set(String(pointEntity.id), { entity: pointEntity, node, floor, index });
  });

  addCorridorDebugEdges(graph, floor, color);

  console.info(`${fileName}: debug points are ${CORRIDOR_DEBUG_HEIGHT_OFFSET}m above floor ${floor === 3 ? "2nd" : "3rd"}.`);
}

function addCorridorDebugEdges(graph: GraphNode[], floor: number, color: Cesium.Color): void {
  graph.forEach((node, index) => {
    node.edges.forEach((edge) => {
      const edgeIndex = graph.indexOf(edge.node);
      if (edgeIndex <= index) return;

      const lineEntity = viewer.entities.add({
        id: `debugCorridorEdge-${floor}-${index}-${edgeIndex}`,
        polyline: {
          positions: new Cesium.CallbackProperty(
            () => [corridorDebugPosition(node, floor), corridorDebugPosition(edge.node, floor)],
            false
          ),
          width: 3,
          material: color.withAlpha(0.62),
          clampToGround: false,
        },
      });

      corridorDebugEntities.push({ entity: lineEntity, floor, kind: "edge" });
    });
  });
}

function redrawCorridorDebugEdges(floor: number): void {
  for (let index = corridorDebugEntities.length - 1; index >= 0; index -= 1) {
    const item = corridorDebugEntities[index];
    if (item.floor !== floor || item.kind !== "edge") continue;

    viewer.entities.remove(item.entity);
    corridorDebugEntities.splice(index, 1);
  }

  const graph = corridorDebugFiles.get(floor)?.graph;
  if (!graph) return;

  const color = floor === 3
    ? Cesium.Color.fromCssColorString("#00D5FF")
    : Cesium.Color.fromCssColorString("#FFB000");
  addCorridorDebugEdges(graph, floor, color);
  updateNavigationVisibility(currentVisibleFloor);
}

export async function installCorridorPointDebug(): Promise<void> {
  if (!corridorDebugEnabled() || corridorDebugLoaded) return;
  corridorDebugLoaded = true;

  const [graph2, graph3, geoJson2Response, geoJson3Response] = await Promise.all([
    centerlineGraph2 ? Promise.resolve(centerlineGraph2) : loadCenterlineGeoJSON("2nd_floor_corridor.geojson", ALT_2ND),
    centerlineGraph3 ? Promise.resolve(centerlineGraph3) : loadCenterlineGeoJSON("3rd_floor_corridor.geojson", ALT_3RD),
    fetch(geoJsonUrl("2nd_floor_corridor.geojson")),
    fetch(geoJsonUrl("3rd_floor_corridor.geojson")),
  ]);
  const [geoJson2, geoJson3] = await Promise.all([
    geoJson2Response.json() as Promise<{ features: CorridorDebugFeature[] }>,
    geoJson3Response.json() as Promise<{ features: CorridorDebugFeature[] }>,
  ]);

  centerlineGraph2 = graph2;
  centerlineGraph3 = graph3;
  corridorDebugFiles.set(3, {
    fileName: "2nd_floor_corridor.geojson",
    graph: graph2,
    features: geoJson2.features.filter((feature) => feature.geometry?.type === "Point"),
  });
  corridorDebugFiles.set(4, {
    fileName: "3rd_floor_corridor.geojson",
    graph: graph3,
    features: geoJson3.features.filter((feature) => feature.geometry?.type === "Point"),
  });

  addCorridorDebugGraph(graph2, 3, "2nd_floor_corridor.geojson");
  addCorridorDebugGraph(graph3, 4, "3rd_floor_corridor.geojson");
  installCorridorDebugEditor();
  updateNavigationVisibility(currentVisibleFloor);
  console.info(
    corridorDebugEditable()
      ? `Corridor edit debug: drag points to update. Release mouse or press E to print updated GeoJSON.`
      : `Corridor debug: ${graph2.length} second-floor points, ${graph3.length} third-floor points.`
  );
  viewer.scene.requestRender();
}

function stairDebugEnabled(): boolean {
  const params = new URLSearchParams(window.location.search);
  const value = params.get(STAIR_DEBUG_PARAM);
  return value === "1" || value === "true" || value === "points" || value === "edit";
}

function stairDebugEditable(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get(STAIR_DEBUG_PARAM) === "edit";
}

function customStairDebugPositions(): Cesium.Cartesian3[] {
  const zLift = 0.5 + STAIR_DEBUG_HEIGHT_OFFSET;
  const landingAltitude = (ALT_2ND + ALT_3RD) / 2;

  return CUSTOM_STAIR_PATH.map((point, index) => {
    const height = index <= 2 ? ALT_2ND : index <= 4 ? landingAltitude : ALT_3RD;
    return Cesium.Cartesian3.fromDegrees(point.lon, point.lat, height + zLift);
  });
}

function stairDebugMarkerSvg(index: number): string {
  const label = String(index + 1);
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
  <circle cx="48" cy="48" r="38" fill="#ff1f3d" stroke="#ffffff" stroke-width="8"/>
  <circle cx="48" cy="48" r="44" fill="none" stroke="#111111" stroke-width="4"/>
  <text x="48" y="58" text-anchor="middle" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#ffffff">${label}</text>
</svg>
`)}`;
}

function exportCustomStairPath(): void {
  const lines = CUSTOM_STAIR_PATH
    .map((point) => `  { lon: ${point.lon}, lat: ${point.lat} }`)
    .join(",\n");
  console.info(`Updated CUSTOM_STAIR_PATH:\nconst CUSTOM_STAIR_PATH = [\n${lines}\n];`);
}

function updateStairDebugPoint(index: number, lon: number, lat: number): void {
  CUSTOM_STAIR_PATH[index] = { lon, lat };
  const positions = customStairDebugPositions();

  stairDebugPoints.forEach((point) => {
    point.entity.position = new Cesium.ConstantPositionProperty(positions[point.index]);
  });

  const line = viewer.entities.getById("debugCustomStairPathLine");
  if (line?.polyline) {
    line.polyline.positions = new Cesium.ConstantProperty(positions);
  }
}

function flyToStairDebugPoints(): void {
  const positions = customStairDebugPositions();
  if (positions.length === 0) return;

  const sphere = Cesium.BoundingSphere.fromPoints(positions);
  viewer.camera.flyToBoundingSphere(sphere, {
    duration: 0.9,
    offset: new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(330),
      Cesium.Math.toRadians(-55),
      22
    ),
  });
}

function installStairDebugEditor(): void {
  if (!stairDebugEditable() || stairDebugDragHandler) return;

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  stairDebugDragHandler = handler;

  handler.setInputAction((event: { position: Cesium.Cartesian2 }) => {
    const picked = viewer.scene.pick(event.position);
    const entity = picked?.id instanceof Cesium.Entity ? picked.id : null;
    const point = entity ? stairDebugPoints.get(String(entity.id)) : null;
    if (!point) return;

    selectedStairDebugPoint = point;
    viewer.scene.screenSpaceCameraController.enableInputs = false;
  }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

  handler.setInputAction((event: { endPosition: Cesium.Cartesian2 }) => {
    if (!selectedStairDebugPoint) return;

    const picked = pickCorridorDebugLonLat(event.endPosition);
    if (!picked) return;

    updateStairDebugPoint(selectedStairDebugPoint.index, picked.lon, picked.lat);
    viewer.scene.requestRender();
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  handler.setInputAction(() => {
    if (!selectedStairDebugPoint) return;

    selectedStairDebugPoint = null;
    viewer.scene.screenSpaceCameraController.enableInputs = true;
    exportCustomStairPath();
  }, Cesium.ScreenSpaceEventType.LEFT_UP);

  window.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() === "s") {
      exportCustomStairPath();
    }
  });
}

export function installStairPathDebug(): void {
  if (!stairDebugEnabled() || stairDebugEntities.length > 0) return;

  const positions = customStairDebugPositions();
  const color = Cesium.Color.fromCssColorString("#FF3355");

  const line = viewer.entities.add({
    id: "debugCustomStairPathLine",
    polyline: {
      positions,
      width: 5,
      material: color.withAlpha(0.78),
      clampToGround: false,
    },
  });
  stairDebugEntities.push(line);

  positions.forEach((position, index) => {
    const pointEntity = viewer.entities.add({
      id: `debugCustomStairPathPoint-${index + 1}`,
      position,
      billboard: {
        image: stairDebugMarkerSvg(index),
        width: stairDebugEditable() ? 58 : 48,
        height: stairDebugEditable() ? 58 : 48,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      point: {
        pixelSize: stairDebugEditable() ? 38 : 30,
        color,
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: `${index + 1}`,
        font: "bold 20px sans-serif",
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 5,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -34),
        showBackground: true,
        backgroundColor: Cesium.Color.BLACK.withAlpha(0.58),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    stairDebugEntities.push(pointEntity);
    stairDebugPoints.set(String(pointEntity.id), { index, entity: pointEntity });
  });

  installStairDebugEditor();
  updateNavigationVisibility(currentVisibleFloor);
  flyToStairDebugPoints();
  window.setTimeout(flyToStairDebugPoints, 900);
  console.info(
    stairDebugEditable()
      ? `Stair edit debug: drag points 1-${CUSTOM_STAIR_PATH.length}. Release mouse or press S to print updated CUSTOM_STAIR_PATH.`
      : `Stair debug: showing ${CUSTOM_STAIR_PATH.length} CUSTOM_STAIR_PATH points.`
  );
  viewer.scene.requestRender();
}

function intermediateDebugEnabled(): boolean {
  const params = new URLSearchParams(window.location.search);
  const value = params.get(INTERMEDIATE_DEBUG_PARAM) ?? params.get(INTERMIDIATE_DEBUG_PARAM);
  return value === "1" || value === "true" || value === "points" || value === "edit";
}

function intermediateDebugEditable(): boolean {
  const params = new URLSearchParams(window.location.search);
  return params.get(INTERMEDIATE_DEBUG_PARAM) === "edit" || params.get(INTERMIDIATE_DEBUG_PARAM) === "edit";
}

function intermediateDebugAltitude(idNo: number): number {
  const landingAltitude = (ALT_2ND + ALT_3RD) / 2;
  if (idNo <= 3) return ALT_2ND + INTERMEDIATE_DEBUG_HEIGHT_OFFSET;
  if (idNo <= 5) return landingAltitude + INTERMEDIATE_DEBUG_HEIGHT_OFFSET;
  return ALT_3RD + INTERMEDIATE_DEBUG_HEIGHT_OFFSET;
}

function intermediateDebugPosition(feature: IntermediatePointFeature): Cesium.Cartesian3 {
  const coordinates = feature.geometry?.coordinates ?? [0, 0];
  const idNo = Number(feature.properties?.id_no ?? 0);
  return Cesium.Cartesian3.fromDegrees(coordinates[0], coordinates[1], intermediateDebugAltitude(idNo));
}

function intermediateDebugMarkerSvg(idNo: number): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="104" height="104" viewBox="0 0 104 104">
  <circle cx="52" cy="52" r="40" fill="#6d38ff" stroke="#ffffff" stroke-width="8"/>
  <circle cx="52" cy="52" r="47" fill="none" stroke="#101426" stroke-width="5"/>
  <text x="52" y="64" text-anchor="middle" font-family="Arial, sans-serif" font-size="38" font-weight="700" fill="#ffffff">${idNo}</text>
</svg>
`)}`;
}

function exportIntermediatePointGeoJSON(): void {
  const geoJson = {
    type: "FeatureCollection",
    name: "intermidiate_point",
    crs: { type: "name", properties: { name: "urn:ogc:def:crs:OGC:1.3:CRS84" } },
    features: intermediateDebugFeatures,
  };
  console.info("Updated intermidiate_point.geojson", JSON.stringify(geoJson, null, 2));
}

function updateIntermediateDebugPoint(point: IntermediatePointState, lon: number, lat: number): void {
  point.feature.geometry = { type: "Point", coordinates: [lon, lat] };
  point.feature.properties = {
    ...point.feature.properties,
    long: lon,
    lat,
  };
  point.entity.position = new Cesium.ConstantPositionProperty(intermediateDebugPosition(point.feature));

  const line = viewer.entities.getById("debugIntermediatePointLine");
  if (line?.polyline) {
    const orderedPositions = intermediateDebugFeatures
      .filter((feature) => feature.geometry?.type === "Point")
      .sort((a, b) => Number(a.properties?.id_no ?? 0) - Number(b.properties?.id_no ?? 0))
      .map(intermediateDebugPosition);
    line.polyline.positions = new Cesium.ConstantProperty(orderedPositions);
  }
}

function installIntermediateDebugEditor(): void {
  if (!intermediateDebugEditable() || intermediateDebugDragHandler) return;

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  intermediateDebugDragHandler = handler;

  handler.setInputAction((event: { position: Cesium.Cartesian2 }) => {
    const picked = viewer.scene.pick(event.position);
    const entity = picked?.id instanceof Cesium.Entity ? picked.id : null;
    const point = entity ? intermediateDebugPoints.get(String(entity.id)) : null;
    if (!point) return;

    selectedIntermediateDebugPoint = point;
    viewer.scene.screenSpaceCameraController.enableInputs = false;
  }, Cesium.ScreenSpaceEventType.LEFT_DOWN);

  handler.setInputAction((event: { endPosition: Cesium.Cartesian2 }) => {
    if (!selectedIntermediateDebugPoint) return;

    const picked = pickCorridorDebugLonLat(event.endPosition);
    if (!picked) return;

    updateIntermediateDebugPoint(selectedIntermediateDebugPoint, picked.lon, picked.lat);
    viewer.scene.requestRender();
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  handler.setInputAction(() => {
    if (!selectedIntermediateDebugPoint) return;

    selectedIntermediateDebugPoint = null;
    viewer.scene.screenSpaceCameraController.enableInputs = true;
    exportIntermediatePointGeoJSON();
  }, Cesium.ScreenSpaceEventType.LEFT_UP);

  window.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() === "i") {
      exportIntermediatePointGeoJSON();
    }
  });
}

function flyToIntermediateDebugPoints(): void {
  const positions = intermediateDebugFeatures.map(intermediateDebugPosition);
  if (positions.length === 0) return;

  viewer.camera.flyToBoundingSphere(Cesium.BoundingSphere.fromPoints(positions), {
    duration: 0.9,
    offset: new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(330),
      Cesium.Math.toRadians(-55),
      22
    ),
  });
}

export async function installIntermediatePointDebug(): Promise<void> {
  if (!intermediateDebugEnabled() || intermediateDebugEntities.length > 0) return;

  const response = await fetch(intermediatePointUrl);
  const geoJson = (await response.json()) as { features: IntermediatePointFeature[] };
  intermediateDebugFeatures = geoJson.features.filter((feature) => feature.geometry?.type === "Point");

  const orderedPositions = intermediateDebugFeatures
    .slice()
    .sort((a, b) => Number(a.properties?.id_no ?? 0) - Number(b.properties?.id_no ?? 0))
    .map(intermediateDebugPosition);

  const line = viewer.entities.add({
    id: "debugIntermediatePointLine",
    polyline: {
      positions: orderedPositions,
      width: 5,
      material: Cesium.Color.fromCssColorString("#6d38ff").withAlpha(0.78),
      clampToGround: false,
    },
  });
  intermediateDebugEntities.push(line);

  intermediateDebugFeatures.forEach((feature, index) => {
    const idNo = Number(feature.properties?.id_no ?? index + 1);
    const entity = viewer.entities.add({
      id: `debugIntermediatePoint-${idNo}`,
      position: intermediateDebugPosition(feature),
      billboard: {
        image: intermediateDebugMarkerSvg(idNo),
        width: intermediateDebugEditable() ? 60 : 50,
        height: intermediateDebugEditable() ? 60 : 50,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      point: {
        pixelSize: intermediateDebugEditable() ? 38 : 30,
        color: Cesium.Color.fromCssColorString("#6d38ff"),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 5,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: `I${idNo}`,
        font: "bold 16px sans-serif",
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 4,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -38),
        showBackground: true,
        backgroundColor: Cesium.Color.BLACK.withAlpha(0.58),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });

    intermediateDebugEntities.push(entity);
    intermediateDebugPoints.set(String(entity.id), { entity, feature, index, idNo });
  });

  installIntermediateDebugEditor();
  updateNavigationVisibility(currentVisibleFloor);
  flyToIntermediateDebugPoints();
  window.setTimeout(flyToIntermediateDebugPoints, 900);
  console.info(
    intermediateDebugEditable()
      ? `Intermediate point edit debug: drag points. Release mouse or press I to print updated intermidiate_point.geojson.`
      : `Intermediate point debug: showing ${intermediateDebugFeatures.length} intermidiate_point.geojson points.`
  );
  viewer.scene.requestRender();
}

async function loadDoorGeoJSON(fileName: string, floorAltitude: number, floor: number): Promise<void> {
  const response = await fetch(geoJsonUrl(fileName));
  const json = (await response.json()) as { features: DoorFeature[] };

  for (const feature of json.features) {
    const roomName = feature.properties.room_name;
    const geometry = feature.geometry;
    let lonDeg: number;
    let latDeg: number;

    if (geometry.type === "Point") {
      [lonDeg, latDeg] = geometry.coordinates;
    } else {
      const coordinates =
        Array.isArray(geometry.coordinates[0]) && Array.isArray(geometry.coordinates[0][0])
          ? geometry.coordinates[0][0]
          : geometry.coordinates[0];
      const totals = coordinates.reduce(
        (accumulator: { lon: number; lat: number }, coordinate: [number, number]) => ({
          lon: accumulator.lon + coordinate[0],
          lat: accumulator.lat + coordinate[1]
        }),
        { lon: 0, lat: 0 }
      );
      lonDeg = totals.lon / coordinates.length;
      latDeg = totals.lat / coordinates.length;
    }

    const position = Cesium.Cartesian3.fromDegrees(lonDeg, latDeg, floorAltitude + 0.1);
    doorPositions.set(`${floor}|${roomName}`, position);
    doorPositions.set(`${floor}|${normalizeRoomName(roomName)}`, position);
  }
}

async function loadCenterlineGeoJSON(fileName: string, altitude: number): Promise<GraphNode[]> {
  const response = await fetch(geoJsonUrl(fileName));
  const geoJsonData = (await response.json()) as {
    features: Array<{
      geometry?: { type: string; coordinates: [number, number] };
      properties?: { id?: number | string };
    }>;
  };

  const points = geoJsonData.features
    .filter((feature) => feature.geometry?.type === "Point")
    .map((feature, index) => {
      const coordinates = feature.geometry?.coordinates ?? [0, 0];
      return {
        lon: coordinates[0],
        lat: coordinates[1],
        id: feature.properties?.id ?? `node-${index}`
      };
    });

  return buildCenterlineGraph(points, altitude);
}

function buildCenterlineGraph(points: Array<{ lon: number; lat: number; id: number | string }>, altitude: number): GraphNode[] {
  const graph: GraphNode[] = points.map((point) => ({
    pos: Cesium.Cartesian3.fromDegrees(point.lon, point.lat, altitude + 0.1),
    lon: point.lon,
    lat: point.lat,
    id: point.id,
    edges: []
  }));

  rebuildCenterlineGraphEdges(graph);
  return graph;
}

function rebuildCenterlineGraphEdges(graph: GraphNode[]): void {
  graph.forEach((node) => {
    node.edges = [];
  });

  for (let i = 0; i < graph.length; i += 1) {
    const nearestNodes = graph
      .map((node, index) => ({
        node,
        index,
        distance: Cesium.Cartesian3.distance(graph[i].pos, node.pos)
      }))
      .filter((candidate) => candidate.index !== i && candidate.distance <= MAX_CORRIDOR_EDGE_METERS)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, MAX_CORRIDOR_NEAREST_NEIGHBORS);

    nearestNodes.forEach((candidate) => {
      addGraphEdge(graph[i], candidate.node, candidate.distance);
    });
  }
}

function addGraphEdge(from: GraphNode, to: GraphNode, distance: number): void {
  if (!from.edges.some((edge) => edge.node === to)) {
    from.edges.push({ node: to, w: distance });
  }

  if (!to.edges.some((edge) => edge.node === from)) {
    to.edges.push({ node: from, w: distance });
  }
}

function findPath(graph: GraphNode[], start: GraphNode, goal: GraphNode): Cesium.Cartesian3[] | null {
  const unvisited = new Set(graph);
  const previous = new Map<GraphNode, GraphNode>();
  const distanceByNode = new Map<GraphNode, number>();

  graph.forEach((node) => distanceByNode.set(node, Number.POSITIVE_INFINITY));
  distanceByNode.set(start, 0);

  while (unvisited.size > 0) {
    let selectedNode: GraphNode | null = null;
    let currentDistance = Number.POSITIVE_INFINITY;

    for (const node of unvisited) {
      const nodeDistance = distanceByNode.get(node) ?? Number.POSITIVE_INFINITY;
      if (nodeDistance < currentDistance) {
        selectedNode = node;
        currentDistance = nodeDistance;
      }
    }

    if (!selectedNode || currentDistance === Number.POSITIVE_INFINITY) break;
    const current = selectedNode;
    if (current === goal) break;

    unvisited.delete(current);

    for (const edge of current.edges) {
      if (!unvisited.has(edge.node)) continue;

      const nextDistance = currentDistance + edge.w;
      if (nextDistance < (distanceByNode.get(edge.node) ?? Number.POSITIVE_INFINITY)) {
        distanceByNode.set(edge.node, nextDistance);
        previous.set(edge.node, current);
      }
    }
  }

  if (start !== goal && !previous.has(goal)) return null;

  const path: Cesium.Cartesian3[] = [];
  let node: GraphNode | undefined = goal;
  while (node) {
    path.unshift(node.pos);
    node = previous.get(node);
  }

  return path;
}

function nearest(graph: GraphNode[], position: Cesium.Cartesian3): GraphNode {
  let best = graph[0];
  let bestDistance = Infinity;

  for (const node of graph) {
    const distance = Cesium.Cartesian3.distance(node.pos, position);
    if (distance < bestDistance) {
      best = node;
      bestDistance = distance;
    }
  }

  return best;
}

function nearestPathIndex(path: Cesium.Cartesian3[], position: Cesium.Cartesian3): number {
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  path.forEach((point, index) => {
    const distance = Cesium.Cartesian3.distance(point, position);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function headingENU(start: Cesium.Cartesian3, end: Cesium.Cartesian3): number {
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(start);
  const inverse = Cesium.Matrix4.inverse(enu, new Cesium.Matrix4());
  const localStart = Cesium.Matrix4.multiplyByPoint(inverse, start, new Cesium.Cartesian3());
  const localEnd = Cesium.Matrix4.multiplyByPoint(inverse, end, new Cesium.Cartesian3());
  return Math.atan2(localEnd.y - localStart.y, localEnd.x - localStart.x);
}

function samplePathByDistance(path: Cesium.Cartesian3[], spacingMeters = 1.2): Cesium.Cartesian3[] {
  if (path.length < 2) return path;

  const sampled: Cesium.Cartesian3[] = [path[0]];
  let carry = 0;

  for (let i = 1; i < path.length; i += 1) {
    const start = path[i - 1];
    const end = path[i];
    const segmentLength = Cesium.Cartesian3.distance(start, end);
    if (segmentLength < 0.001) continue;

    let distance = spacingMeters - carry;

    while (distance < segmentLength) {
      const t = distance / segmentLength;
      sampled.push(Cesium.Cartesian3.lerp(start, end, t, new Cesium.Cartesian3()));
      distance += spacingMeters;
    }

    carry = segmentLength - (distance - spacingMeters);
  }

  sampled.push(path[path.length - 1]);
  return sampled;
}

function addRouteBubbles(
  collection: Cesium.BillboardCollection,
  path: Cesium.Cartesian3[],
  spacingMeters = 0.45
): Cesium.Cartesian3[] {
  const points = samplePathByDistance(path, spacingMeters);
  const billboards = collection === routeBubbleCollectionA ? routeBubbleBillboardsA : routeBubbleBillboardsB;
  const tValues = collection === routeBubbleCollectionA ? routeDotTValuesA : routeDotTValuesB;

  points.forEach((position, index) => {
    const t = points.length > 1 ? index / (points.length - 1) : 0;
    const billboard = collection.add({
      position,
      image: ROUTE_BUBBLE_SVG,
      scale: 0.09,
      color: Cesium.Color.WHITE.withAlpha(0.32),
      scaleByDistance: new Cesium.NearFarScalar(8, 1.2, 100, 1.5),
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
    billboards.push(billboard);
    tValues.push(t);
  });

  return points;
}

function routeBubbleStrideForCamera(): number {
  const height = viewer.camera.positionCartographic.height;
  if (height < 45) return 1;
  if (height < 100) return 1;
  if (height < 170) return 2;
  return 3;
}

function applyRouteBubbleDensity(force = false): void {
  const stride = routeBubbleStrideForCamera();
  if (!force && stride === routeBubbleDensityStride) return;

  routeBubbleDensityStride = stride;
  const updateBillboards = (billboards: Cesium.Billboard[]) => {
    const segment = billboards === routeBubbleBillboardsA ? "A" : "B";
    const lastIndex = billboards.length - 1;
    billboards.forEach((billboard, index) => {
      billboard.show = isRouteBubbleAhead(segment, index) && (index === lastIndex || index % stride === 0);
    });
  };

  updateBillboards(routeBubbleBillboardsA);
  updateBillboards(routeBubbleBillboardsB);
  viewer.scene.requestRender();
}

function addGlowBillboards(
  collection: Cesium.BillboardCollection,
  count = 2
): Cesium.Billboard[] {
  const glows: Cesium.Billboard[] = [];
  for (let i = 0; i < count; i += 1) {
    glows.push(collection.add({
      position: Cesium.Cartesian3.ZERO,
      image: ROUTE_GLOW_SVG,
      scale: 0.32,
      color: Cesium.Color.WHITE.withAlpha(0.85),
      verticalOrigin: Cesium.VerticalOrigin.CENTER,
      horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      show: false,
    }));
  }
  return glows;
}

function startRouteGlowAnimation(
  pointsA: Cesium.Cartesian3[],
  pointsB: Cesium.Cartesian3[]
): void {
  if (routeAnimRemove !== null) {
    routeAnimRemove();
    routeAnimRemove = null;
  }

  routeGlowCollectionA.removeAll();
  routeGlowCollectionB.removeAll();

  const glowsA = addGlowBillboards(routeGlowCollectionA, 2);
  const glowsB = addGlowBillboards(routeGlowCollectionB, 2);

  routeAnimStart = performance.now();

  // 3 pulse waves flow from start→end simultaneously at 60fps
  const WAVES = 3;
  const SPEED = 0.55;  // path traversals per second
  const SIGMA = 0.16;  // gaussian half-width (fraction of path)

  routeAnimRemove = viewer.scene.postRender.addEventListener(() => {
    const elapsed = (performance.now() - routeAnimStart) * 0.001;
    const cycleT = elapsed * SPEED;

    // Flowing brightness wave across dots
    const updateDots = (billboards: Cesium.Billboard[], tValues: number[]) => {
      billboards.forEach((bb, i) => {
        if (!bb.show) return;
        const dotT = tValues[i] ?? 0;
        let peak = 0;
        for (let w = 0; w < WAVES; w++) {
          const waveT = (cycleT + w / WAVES) % 1;
          let dist = Math.abs(waveT - dotT);
          if (dist > 0.5) dist = 1 - dist;
          peak = Math.max(peak, Math.exp(-(dist * dist) / (2 * SIGMA * SIGMA)));
        }
        bb.scale = 0.085 + 0.135 * peak;
        bb.color = Cesium.Color.WHITE.withAlpha(0.30 + 0.70 * peak);
      });
    };

    updateDots(routeBubbleBillboardsA, routeDotTValuesA);
    updateDots(routeBubbleBillboardsB, routeDotTValuesB);

    // Two bright glow orbs ride the path
    const updateGlows = (points: Cesium.Cartesian3[], glows: Cesium.Billboard[]) => {
      if (points.length === 0) { glows.forEach((g) => { g.show = false; }); return; }
      glows.forEach((glow, i) => {
        const waveT = (cycleT + i / glows.length) % 1;
        const idx = Math.min(Math.floor(waveT * points.length), points.length - 1);
        glow.position = points[idx];
        glow.show = true;
        glow.scale = 0.30 + 0.10 * Math.sin(elapsed * 4.5 + i * 2.5);
        glow.color = Cesium.Color.WHITE.withAlpha(0.75 + 0.20 * Math.sin(elapsed * 3 + i));
      });
    };

    updateGlows(pointsA, glowsA);
    updateGlows(pointsB, glowsB);

    viewer.scene.requestRender();
  });
}

function generateTurnSteps(path: Cesium.Cartesian3[]): Array<{ icon: string; title: string; primary: string }> {
  if (path.length < 2) return [];
  const steps: Array<{ icon: string; title: string; primary: string }> = [];
  
  let currentHeading = headingENU(path[0], path[1]);
  let accumulatedDistance = Cesium.Cartesian3.distance(path[0], path[1]);
  
  steps.push({
    icon: "↑",
    title: "Start",
    primary: "Go forward"
  });
  
  for (let i = 1; i < path.length - 1; i++) {
    const p1 = path[i];
    const p2 = path[i+1];
    const distance = Cesium.Cartesian3.distance(p1, p2);
    if (distance < 0.8) {
      accumulatedDistance += distance;
      continue; 
    }
    
    const nextHeading = headingENU(p1, p2);
    let angleDiff = nextHeading - currentHeading;
    while (angleDiff > Math.PI) angleDiff -= 2 * Math.PI;
    while (angleDiff < -Math.PI) angleDiff += 2 * Math.PI;
    
    if (Math.abs(angleDiff) > 0.45) { // roughly 25 degrees
      steps[steps.length - 1].primary += ` for ${Math.max(1, Math.round(accumulatedDistance))} m`;
      
      const turnDir = angleDiff > 0 ? "left" : "right";
      steps.push({
        icon: angleDiff > 0 ? "↰" : "↱",
        title: `Turn ${turnDir}`,
        primary: `Turn ${turnDir} and go ahead`
      });
      
      currentHeading = nextHeading;
      accumulatedDistance = distance;
    } else {
      accumulatedDistance += distance;
    }
  }
  
  steps[steps.length - 1].primary += ` for ${Math.max(1, Math.round(accumulatedDistance))} m`;
  return steps;
}

function drawRoute(
  pathA: Cesium.Cartesian3[],
  pathB: Cesium.Cartesian3[]
): { pointsA: Cesium.Cartesian3[]; pointsB: Cesium.Cartesian3[] } {
  clearRouteEntities();

  let pointsA: Cesium.Cartesian3[] = [];
  let pointsB: Cesium.Cartesian3[] = [];

  if (pathA.length > 1) {
    viewer.entities.add({
      id: "navigationLineA",
      show: false,
      polyline: {
        positions: pathA,
        width: 1,
        material: Cesium.Color.TRANSPARENT,
      },
    });

    pointsA = addRouteBubbles(routeBubbleCollectionA, pathA, 0.40);
  }

  if (pathB.length > 1) {
    viewer.entities.add({
      id: "navigationLineB",
      show: false,
      polyline: {
        positions: pathB,
        width: 1,
        material: Cesium.Color.TRANSPARENT,
      },
    });

    pointsB = addRouteBubbles(routeBubbleCollectionB, pathB, 0.40);
  }

  const start = pathA[0];
  const end = pathB.length > 0
    ? pathB[pathB.length - 1]
    : pathA[pathA.length - 1];

  viewer.entities.add({
    id: "startMarker",
    position: start,
    point: {
      pixelSize: 28,
      color: Cesium.Color.fromCssColorString("#0055FF"),
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 6,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });

  viewer.entities.add({
    id: "endMarker",
    position: end,
    point: {
      pixelSize: new Cesium.CallbackProperty(() => 24 + 6 * Math.abs(Math.sin(performance.now() * 0.004)), false),
      color: Cesium.Color.fromCssColorString("#FF2200"),
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 6,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });

  startRouteGlowAnimation(pointsA, pointsB);
  updateNavigationVisibility(currentVisibleFloor);
  viewer.scene.requestRender();

  return { pointsA, pointsB };
}

async function ensureNavData(): Promise<void> {
  if (navDataReady) return;

  const [graph2, graph3] = await Promise.all([
    centerlineGraph2 ? Promise.resolve(centerlineGraph2) : loadCenterlineGeoJSON("2nd_floor_corridor.geojson", ALT_2ND),
    centerlineGraph3 ? Promise.resolve(centerlineGraph3) : loadCenterlineGeoJSON("3rd_floor_corridor.geojson", ALT_3RD)
  ]);
  centerlineGraph2 = graph2;
  centerlineGraph3 = graph3;

  if (doorPositions.size === 0) {
    await Promise.all([loadDoorGeoJSON("door_2nd.geojson", ALT_2ND, 3), loadDoorGeoJSON("door_3rd.geojson", ALT_3RD, 4)]);
  }

  navDataReady = true;
}

function getSelectValue(id: string): string {
  const element = document.getElementById(id) as HTMLSelectElement | null;
  return element?.value ?? "";
}

function getEntityRoomName(entity: Cesium.Entity): string | undefined {
  const value = (entity.properties as any)?.room_name;
  return typeof value?.getValue === "function" ? value.getValue() : undefined;
}

function parseFloorAwareRoomLabel(value: string): { roomName: string; floor: number | null } {
  const match = value.match(/^(.*)\s+\((2nd|3rd) Floor\)$/);
  if (!match) return { roomName: value, floor: null };

  return {
    roomName: match[1],
    floor: match[2] === "2nd" ? 3 : 4,
  };
}

function roomExistsOnFloor(roomName: string, floor: number): boolean {
  const dataSource = floor === 3 ? geo2 : geo3;
  const target = normalizeRoomName(roomName);
  return Boolean(dataSource?.entities.values.some((entity) => normalizeRoomName(getEntityRoomName(entity)) === target));
}

function resolveRoomSelection(value: string): ResolvedRoomSelection | null {
  if (!value) return null;

  const parsed = parseFloorAwareRoomLabel(value);
  const floor = parsed.floor ?? (roomExistsOnFloor(parsed.roomName, 3) ? 3 : roomExistsOnFloor(parsed.roomName, 4) ? 4 : null);
  if (!floor) return null;

  return {
    displayName: value,
    roomName: parsed.roomName,
    floor,
  };
}

function getRoomFallbackPosition(roomName: string, floor: number): Cesium.Cartesian3 | undefined {
  const dataSource = floor === 3 ? geo2 : geo3;
  const target = normalizeRoomName(roomName);
  const entity = dataSource?.entities.values.find((candidate) => normalizeRoomName(getEntityRoomName(candidate)) === target);
  const position = entity?.position?.getValue(Cesium.JulianDate.now());
  if (position) return position;

  const hierarchy = entity?.polygon?.hierarchy?.getValue(Cesium.JulianDate.now());
  const positions = hierarchy?.positions ?? [];
  if (positions.length === 0) return undefined;

  const sphere = Cesium.BoundingSphere.fromPoints(positions);
  const cartographic = Cesium.Cartographic.fromCartesian(sphere.center);
  const altitude = floor === 3 ? ALT_2ND : ALT_3RD;
  return Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, altitude + 0.1);
}

function getDoorPosition(roomName: string, floor: number): Cesium.Cartesian3 | undefined {
  if (floor === 3 && normalizeRoomName(roomName) === "pantry") {
    return SECOND_FLOOR_PANTRY_EMPLOYEE_SIDE_DOOR;
  }

  return doorPositions.get(`${floor}|${roomName}`)
    ?? doorPositions.get(`${floor}|${normalizeRoomName(roomName)}`)
    ?? getRoomFallbackPosition(roomName, floor);
}

function shouldUseFirstThirdFloorPantryDoor(otherSelection: ResolvedRoomSelection): boolean {
  // Cross-floor routes enter/exit Pantry through the first door.
  // Same-floor 3rd-floor routes use Pantry's second door.
  return otherSelection.floor !== 4;
}

function getRouteDoorPosition(
  selection: ResolvedRoomSelection,
  otherSelection: ResolvedRoomSelection
): Cesium.Cartesian3 | undefined {
  if (selection.floor === 4 && normalizeRoomName(selection.roomName) === "pantry") {
    return shouldUseFirstThirdFloorPantryDoor(otherSelection)
      ? THIRD_FLOOR_PANTRY_NEAR_CONFERENCE_DOOR
      : THIRD_FLOOR_PANTRY_LOWER_DOOR;
  }

  return getDoorPosition(selection.roomName, selection.floor);
}

function graphForFloor(floor: number): GraphNode[] | null {
  return floor === 3 ? centerlineGraph2 : centerlineGraph3;
}

function floorLabel(floor: number): string {
  return floor === 3 ? "2nd Floor" : floor === 4 ? "3rd Floor" : `Floor ${floor}`;
}

function floorForNavigationPosition(position: Cesium.Cartesian3, fallbackFloor: number): number {
  const height = Cesium.Cartographic.fromCartesian(position).height;
  const secondFloorDistance = Math.abs(height - ALT_2ND);
  const thirdFloorDistance = Math.abs(height - ALT_3RD);

  if (!Number.isFinite(height)) return fallbackFloor;
  return secondFloorDistance <= thirdFloorDistance ? 3 : 4;
}
function pathDistance(paths: Cesium.Cartesian3[][]): number {
  let total = 0;
  for (const path of paths) {
    for (let index = 1; index < path.length; index += 1) {
      total += Cesium.Cartesian3.distance(path[index - 1], path[index]);
    }
  }
  return total;
}

export async function startNavigation(): Promise<void> {
  if (!geo2 || !geo3) {
    setNavigationMessage("Room data is still loading.");
    return;
  }

  await ensureNavData();

  const fromName = getSelectValue("fromRoom");
  const toName = getSelectValue("toRoom");
  const fromSelection = resolveRoomSelection(fromName);
  const toSelection = resolveRoomSelection(toName);
  if (!fromSelection || !toSelection) {
    setNavigationMessage("Choose a start and destination.");
    return;
  }

  const fromFloor = fromSelection.floor;
  const toFloor = toSelection.floor;
  const graphA = graphForFloor(fromFloor);
  const graphB = graphForFloor(toFloor);
  const startDoorPosition = getRouteDoorPosition(fromSelection, toSelection);
  const endDoorPosition = getRouteDoorPosition(toSelection, fromSelection);

  if (!graphA || !graphB || !startDoorPosition || !endDoorPosition) {
    setNavigationMessage("No route data for the selected rooms.");
    return;
  }

  const zLift = 0.5;
  let pathFloorA: Cesium.Cartesian3[] = [];
  let pathFloorB: Cesium.Cartesian3[] = [];
  let stairStartPosition: Cesium.Cartesian3 | null = null;
  let stairEndPosition: Cesium.Cartesian3 | null = null;

  if (fromFloor === toFloor) {
    const path = findPath(graphA, nearest(graphA, startDoorPosition), nearest(graphA, endDoorPosition));
    if (!path) {
      setNavigationMessage("No route found.");
      return;
    }
    pathFloorA = [startDoorPosition, ...path, endDoorPosition].map((position) =>
      Cesium.Cartesian3.add(position, new Cesium.Cartesian3(0, 0, zLift), new Cesium.Cartesian3())
    );
  } else {
    const startAltitude = fromFloor === 3 ? ALT_2ND : ALT_3RD;
    const targetAltitude = fromFloor === 3 ? ALT_3RD : ALT_2ND;
    const landingAltitude = (startAltitude + targetAltitude) / 2;
    const bridge = fromFloor === 3 ? [...CUSTOM_STAIR_PATH] : [...CUSTOM_STAIR_PATH].reverse();
    const stairPath3D = bridge.map((point, index) => {
      let height: number;
      if (fromFloor === 3) {
        height = index <= 2 ? startAltitude : index <= 4 ? landingAltitude : targetAltitude;
      } else {
        height = index <= 1 ? startAltitude : index <= 3 ? landingAltitude : targetAltitude;
      }
      return Cesium.Cartesian3.fromDegrees(point.lon, point.lat, height + zLift);
    });
    stairStartPosition = stairPath3D[0];
    stairEndPosition = stairPath3D[stairPath3D.length - 1];

    const part1 = findPath(graphA, nearest(graphA, startDoorPosition), nearest(graphA, stairPath3D[0]));
    const part2 = findPath(graphB, nearest(graphB, stairPath3D[stairPath3D.length - 1]), nearest(graphB, endDoorPosition));
    if (!part1 || !part2) {
      setNavigationMessage("No route found.");
      return;
    }

    pathFloorA = [startDoorPosition, ...part1].map((position) =>
      Cesium.Cartesian3.add(position, new Cesium.Cartesian3(0, 0, zLift), new Cesium.Cartesian3())
    );
    pathFloorA.push(stairPath3D[0]);

    const liftedHallwayB = [...part2, endDoorPosition].map((position) =>
      Cesium.Cartesian3.add(position, new Cesium.Cartesian3(0, 0, zLift), new Cesium.Cartesian3())
    );
    pathFloorB = [...stairPath3D, ...liftedHallwayB];
  }

  activeNavFromFloor = fromFloor;
  activeNavToFloor = toFloor;
  setNavigationAllowedFloors([...new Set([fromFloor, toFloor])]);

  // If navigation crosses floors, show loading spinner and ensure both floor models are loaded
  if (fromFloor !== toFloor) {
    showFloorSpinner("Preparing navigation…");
    try {
      await Promise.all([ensureFloorModelLoaded(fromFloor), ensureFloorModelLoaded(toFloor)]);
    } catch (err) {
      console.warn("Failed to preload floor models for navigation:", err);
    } finally {
      hideFloorSpinner();
    }
  }

  await Promise.resolve(navigationFloorSwitchHandler?.(fromFloor));
  disableCameraControls();

  const { pointsA, pointsB } = drawRoute(pathFloorA, pathFloorB);
  const fullPath = [...pointsA, ...pointsB];
  const stairRange = stairStartPosition && stairEndPosition
    ? {
        startIndex: Math.max(0, nearestPathIndex(fullPath, stairStartPosition) - 1),
        endIndex: nearestPathIndex(fullPath, stairEndPosition) + 1
      }
    : undefined;
  const fullPathFloors = [
    ...pointsA.map((position) => floorForNavigationPosition(position, fromFloor)),
    ...pointsB.map((position) => floorForNavigationPosition(position, toFloor)),
  ];

  const totalDistance = Math.round(pathDistance([pathFloorA, pathFloorB]));
  
  // Generate turn-by-turn steps
  const allSteps: any[] = [];
  if (pathFloorA.length > 0) {
    allSteps.push(...generateTurnSteps(pathFloorA));
  }
  if (fromFloor !== toFloor) {
    allSteps.push({ icon: "🪜", title: "Use stairs", primary: `Move to ${floorLabel(toFloor)}` });
    if (pathFloorB.length > 0) {
      allSteps.push(...generateTurnSteps(pathFloorB));
    }
  }
  allSteps.push({ icon: "🚩", title: "Arrive at destination", text: `You have reached ${toSelection.displayName}` });

  updateNavigationUI({
    fromName: fromSelection.displayName,
    toName: toSelection.displayName,
    totalDistance,
    totalTime: Math.max(1, Math.round(totalDistance / 80)),
    list: allSteps
  });

  startLiveNavigationMarker(
    fullPath,
    fullPathFloors,
    toSelection.displayName,
    toSelection.roomName,
    toSelection.floor,
    pointsA.length,
    stairRange
  );
  setNavigationMessage(
    fromFloor === toFloor
      ? "Live navigation started. Follow the blue route."
      : "Proceed to stairs, then switch floor to continue.",
    false
  );
  viewer.scene.requestRender();
}

export function getActiveNavigationStartFloor(): number | null {
  return activeNavFromFloor;
}

export function getActiveNavigationEndFloor(): number | null {
  return activeNavToFloor;
}

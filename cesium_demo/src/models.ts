import {
  Cesium,
  ALT_1ST,
  ALT_2ND,
  ALT_3RD,
  ALT_GROUND,
  BASE_ALT,
  MODEL_SCALE,
  computeMatrix,
  viewer
} from "./viewer";
import { FLOOR_CAMERAS } from "./config";
import cameraUrl from "../3rd_cc1.glb?url";
import camera2Url from "../3rd_cc2.glb?url";
import camera3Url from "../3rd_cc3.glb?url";
import camera4Url from "../3rd_cc4.glb?url";
import camera5Url from "../3rd_cc5.glb?url";
import camera6Url from "../3rd_cc6.glb?url";
import conferenceRoomCamUrl from "../3rd_cc6 (1).glb?url";
import camera8Url from "../3rd_cc8.glb?url";
import meetingRoomUrl from "../3rd_cc_meeting_room.glb?url";

import nd2dCam1Url from "../2nd_cc1.glb?url";
import nd2dCam2Url from "../2nd_cc2.glb?url";
import nd2dCam3Url from "../2nd_cc3.glb?url";
import nd2dCam4Url from "../2nd_cc4.glb?url";
import nd2dCam5Url from "../2nd_cc5.glb?url";
import nd2dCam6Url from "../2nd_cc6.glb?url";

import firstFloorUrl from "../1st_floor_up_final.glb?url";
import secondFloorUrl from "../final_2nd_floor_without_chair_fast.glb?url";
import fullBuildingUrl from "../full_building.glb?url";
import groundFloorUrl from "../ground_floor_final.glb?url";
import outdoorModelUrl from "../outdoor_model.glb?url";
import thirdFloorUrl from "../3rd_floor_without_chairs.glb?url";
import secondFloorLoadingBaseUrl from "../2nd_floor_base.glb?url";
import secondFloorLoadingBaseWallUrl from "../2nd_floor_base_wall.glb?url";
import thirdFloorLoadingBaseUrl from "../3rd_floor_base.glb?url";
import thirdFloorLoadingBaseWallUrl from "../3rd_floor_base_wall.glb?url";
import thirdFloorPillerUrl from "../3rd_floor_piller.glb?url";

const chairModelAssets = import.meta.glob<string>(
  ["../[0-9].glb", "../[0-9][0-9].glb", "../final_2nd_floor_[0-9].glb", "../final_2nd_floor_[0-9][0-9].glb"],
  {
    query: "?url",
    import: "default",
    eager: true
  }
);

const modelAssets: Record<string, string> = {
  "../3rd_cc1.glb": cameraUrl,
  "../3rd_cc2.glb": camera2Url,
  "../3rd_cc3.glb": camera3Url,
  "../3rd_cc4.glb": camera4Url,
  "../3rd_cc5.glb": camera5Url,
  "../3rd_cc6.glb": camera6Url,
  "../3rd_cc6 (1).glb": conferenceRoomCamUrl,
  "../3rd_cc8.glb": camera8Url,
  "../3rd_cc_meeting_room.glb": meetingRoomUrl,

  "../2nd_cc1.glb": nd2dCam1Url,
  "../2nd_cc2.glb": nd2dCam2Url,
  "../2nd_cc3.glb": nd2dCam3Url,
  "../2nd_cc4.glb": nd2dCam4Url,
  "../2nd_cc5.glb": nd2dCam5Url,
  "../2nd_cc6.glb": nd2dCam6Url,

  "../full_building_opt.glb": fullBuildingUrl,
  "../ground_floor_final.glb": groundFloorUrl,
  "../1st_floor_up_final.glb": firstFloorUrl,
  "../final_2nd_floor_without_chair.glb": secondFloorUrl,
  "../3rd_floor_without_chairs.glb": thirdFloorUrl,
  "../2nd_floor_base.glb": secondFloorLoadingBaseUrl,
  "../2nd_floor_base_wall.glb": secondFloorLoadingBaseWallUrl,
  "../3rd_floor_base.glb": thirdFloorLoadingBaseUrl,
  "../3rd_floor_base_wall.glb": thirdFloorLoadingBaseWallUrl,
  "../3rd_floor_piller.glb": thirdFloorPillerUrl,
  "../outdoor_model.glb": outdoorModelUrl,
  ...chairModelAssets
};

const floorLoadPromises = new Map<number, Promise<void>>();
let glbUploadQueue = Promise.resolve();
let secondFloorLoadingPreviewToken = 0;
let secondFloorLoadingPreviewActive = false;
let secondFloorLoadingPreviewStage: "off" | "base" | "floor" = "off";
let secondFloorLoadingPreviewTimer: number | null = null;
let secondFloorLoadingBasePromise: Promise<Cesium.Model> | null = null;
let secondFloorLoadingBaseWallPromise: Promise<Cesium.Model> | null = null;
let thirdFloorLoadingPreviewToken = 0;
let thirdFloorLoadingPreviewActive = false;
let thirdFloorLoadingPreviewStage: "off" | "base" | "floor" = "off";
let thirdFloorLoadingPreviewTimer: number | null = null;
let thirdFloorLoadingBasePromise: Promise<Cesium.Model> | null = null;
let thirdFloorLoadingBaseWallPromise: Promise<Cesium.Model> | null = null;

export function modelUrl(fileName: string): string {
  const url = modelAssets[`../${fileName}`];
  if (!url) {
    const known = Object.keys(modelAssets).map((key) => key.replace("../", "")).sort().join(", ");
    throw new Error(`Missing model asset: ${fileName}. Known root GLBs: ${known}`);
  }
  return url;
}

export async function createQueuedModel(options: Parameters<typeof Cesium.Model.fromGltfAsync>[0]): Promise<Cesium.Model> {
  const run = glbUploadQueue
    .catch(() => undefined)
    .then(async () => {
      const model = await Cesium.Model.fromGltfAsync(options);
      await new Promise<void>((resolve) => {
        const remove = viewer.scene.postRender.addEventListener(() => {
          remove();
          window.setTimeout(resolve, 25);
        });
        viewer.scene.requestRender();
      });
      return model;
    });

  glbUploadQueue = run.then(() => undefined, () => undefined);
  return run;
}

export type CameraConfig = {
  lon: number;
  lat: number;
  height: number;
  heading: number;
  pitch: number;
  headingMin?: number;
  headingMax?: number;
  pitchMin?: number;
  pitchMax?: number;
  fovDeg?: number;
  maxRangeMeters?: number;
  eyeOffsetMeters?: number;
  moveBounds?: {
    minLon: number;
    maxLon: number;
    minLat: number;
    maxLat: number;
  };
  moveStepMeters?: number;
  zoomOutDistance?: number;
  lookAheadDistance?: number;
  upwardLift?: number;
};

export interface CameraModel extends Cesium.Model {
  isCamera?: boolean;
  cameraName?: string;
  cameraFloor?: number;
  cameraConfig: CameraConfig;
}

export interface BuildingModels {
  fullBuilding: Cesium.Model | null;
  ground: Cesium.Model | null;
  first: Cesium.Model | null;
  second: Cesium.Model | null;
  third: Cesium.Model | null;
  cameras: CameraModel[];
  outdoor: Cesium.Model | null;
  meetingRoom: Cesium.Model | null;
  thirdFloorPiller: Cesium.Model | null;
  secondFloorLoadingBase: Cesium.Model | null;
  secondFloorLoadingBaseWall: Cesium.Model | null;
  thirdFloorLoadingBase: Cesium.Model | null;
  thirdFloorLoadingBaseWall: Cesium.Model | null;
}

export const models: BuildingModels = {
  fullBuilding: null,
  ground: null,
  first: null,
  second: null,
  third: null,
  cameras: [],
  outdoor: null,
  meetingRoom: null,
  thirdFloorPiller: null,
  secondFloorLoadingBase: null,
  secondFloorLoadingBaseWall: null,
  thirdFloorLoadingBase: null,
  thirdFloorLoadingBaseWall: null
};

async function loadModel(fileName: string, altitude: number, options: { allowPicking?: boolean } = {}): Promise<Cesium.Model> {
  return createQueuedModel({
    url: modelUrl(fileName),
    modelMatrix: computeMatrix(altitude),
    scale: MODEL_SCALE,
    shadows: Cesium.ShadowMode.DISABLED,
    allowPicking: options.allowPicking ?? false,
    cull: true,
    incrementallyLoadTextures: true
  } as any);
}

function addPrimitiveHidden(model: Cesium.Model): void {
  model.show = false;
  viewer.scene.primitives.add(model);
}

async function loadFloorLoadingPreviewModel(fileName: string, altitude: number): Promise<Cesium.Model> {
  const model = await createQueuedModel({
    url: modelUrl(fileName),
    modelMatrix: computeMatrix(altitude),
    scale: MODEL_SCALE,
    shadows: Cesium.ShadowMode.DISABLED,
    allowPicking: false,
    cull: true,
    incrementallyLoadTextures: true
  } as any);
  addPrimitiveHidden(model);
  return model;
}

function ensureSecondFloorLoadingBase(): Promise<Cesium.Model> {
  if (models.secondFloorLoadingBase) return Promise.resolve(models.secondFloorLoadingBase);
  if (!secondFloorLoadingBasePromise) {
    secondFloorLoadingBasePromise = loadFloorLoadingPreviewModel("2nd_floor_base.glb", ALT_2ND)
      .then((model) => {
        models.secondFloorLoadingBase = model;
        return model;
      })
      .catch((error) => {
        secondFloorLoadingBasePromise = null;
        throw error;
      });
  }
  return secondFloorLoadingBasePromise;
}

function ensureSecondFloorLoadingBaseWall(): Promise<Cesium.Model> {
  if (models.secondFloorLoadingBaseWall) return Promise.resolve(models.secondFloorLoadingBaseWall);
  if (!secondFloorLoadingBaseWallPromise) {
    secondFloorLoadingBaseWallPromise = loadFloorLoadingPreviewModel("2nd_floor_base_wall.glb", ALT_2ND)
      .then((model) => {
        models.secondFloorLoadingBaseWall = model;
        return model;
      })
      .catch((error) => {
        secondFloorLoadingBaseWallPromise = null;
        throw error;
      });
  }
  return secondFloorLoadingBaseWallPromise;
}

function ensureThirdFloorLoadingBase(): Promise<Cesium.Model> {
  if (models.thirdFloorLoadingBase) return Promise.resolve(models.thirdFloorLoadingBase);
  if (!thirdFloorLoadingBasePromise) {
    thirdFloorLoadingBasePromise = loadFloorLoadingPreviewModel("3rd_floor_base.glb", ALT_3RD)
      .then((model) => {
        models.thirdFloorLoadingBase = model;
        return model;
      })
      .catch((error) => {
        thirdFloorLoadingBasePromise = null;
        throw error;
      });
  }
  return thirdFloorLoadingBasePromise;
}

function ensureThirdFloorLoadingBaseWall(): Promise<Cesium.Model> {
  if (models.thirdFloorLoadingBaseWall) return Promise.resolve(models.thirdFloorLoadingBaseWall);
  if (!thirdFloorLoadingBaseWallPromise) {
    thirdFloorLoadingBaseWallPromise = loadFloorLoadingPreviewModel("3rd_floor_base_wall.glb", ALT_3RD)
      .then((model) => {
        models.thirdFloorLoadingBaseWall = model;
        return model;
      })
      .catch((error) => {
        thirdFloorLoadingBaseWallPromise = null;
        throw error;
      });
  }
  return thirdFloorLoadingBaseWallPromise;
}

export function stopThirdFloorLoadingPreview(): void {
  thirdFloorLoadingPreviewToken += 1;
  thirdFloorLoadingPreviewActive = false;
  thirdFloorLoadingPreviewStage = "off";
  if (thirdFloorLoadingPreviewTimer !== null) {
    window.clearTimeout(thirdFloorLoadingPreviewTimer);
    thirdFloorLoadingPreviewTimer = null;
  }

  if (models.thirdFloorLoadingBase) models.thirdFloorLoadingBase.show = false;
  if (models.thirdFloorLoadingBaseWall) models.thirdFloorLoadingBaseWall.show = false;
  viewer.scene.requestRender();
}

export function stopSecondFloorLoadingPreview(): void {
  secondFloorLoadingPreviewToken += 1;
  secondFloorLoadingPreviewActive = false;
  secondFloorLoadingPreviewStage = "off";
  if (secondFloorLoadingPreviewTimer !== null) {
    window.clearTimeout(secondFloorLoadingPreviewTimer);
    secondFloorLoadingPreviewTimer = null;
  }

  if (models.secondFloorLoadingBase) models.secondFloorLoadingBase.show = false;
  if (models.secondFloorLoadingBaseWall) models.secondFloorLoadingBaseWall.show = false;
  viewer.scene.requestRender();
}

export function isSecondFloorLoadingPreviewActive(): boolean {
  return secondFloorLoadingPreviewActive;
}

export function isSecondFloorLoadingFloorVisible(): boolean {
  return secondFloorLoadingPreviewActive && secondFloorLoadingPreviewStage === "floor";
}

export function isThirdFloorLoadingPreviewActive(): boolean {
  return thirdFloorLoadingPreviewActive;
}

export function isThirdFloorLoadingFloorVisible(): boolean {
  return thirdFloorLoadingPreviewActive && thirdFloorLoadingPreviewStage === "floor";
}

export function startThirdFloorLoadingPreview(): void {
  const token = ++thirdFloorLoadingPreviewToken;
  thirdFloorLoadingPreviewActive = true;
  thirdFloorLoadingPreviewStage = "base";
  if (thirdFloorLoadingPreviewTimer !== null) {
    window.clearTimeout(thirdFloorLoadingPreviewTimer);
    thirdFloorLoadingPreviewTimer = null;
  }

  if (models.thirdFloorLoadingBaseWall) models.thirdFloorLoadingBaseWall.show = false;

  // Prefetch wall model in background so it is ready by the time we need it
  void ensureThirdFloorLoadingBaseWall()
    .catch((error) => console.error("Failed to preload 3rd floor wall:", error));

  void ensureThirdFloorLoadingBase()
    .then((base) => {
      if (token !== thirdFloorLoadingPreviewToken) { base.show = false; return; }
      base.show = true;
      if (models.thirdFloorLoadingBaseWall) models.thirdFloorLoadingBaseWall.show = false;
      viewer.scene.requestRender();
    })
    .catch((error) => console.error("Failed to load 3rd floor base preview:", error));
}

export function startSecondFloorLoadingPreview(): void {
  const token = ++secondFloorLoadingPreviewToken;
  secondFloorLoadingPreviewActive = true;
  secondFloorLoadingPreviewStage = "base";
  if (secondFloorLoadingPreviewTimer !== null) {
    window.clearTimeout(secondFloorLoadingPreviewTimer);
    secondFloorLoadingPreviewTimer = null;
  }

  if (models.secondFloorLoadingBaseWall) models.secondFloorLoadingBaseWall.show = false;

  void ensureSecondFloorLoadingBaseWall()
    .catch((error) => console.error("Failed to preload 2nd floor wall:", error));

  void ensureSecondFloorLoadingBase()
    .then((base) => {
      if (token !== secondFloorLoadingPreviewToken) { base.show = false; return; }
      base.show = true;
      if (models.secondFloorLoadingBaseWall) models.secondFloorLoadingBaseWall.show = false;
      viewer.scene.requestRender();
    })
    .catch((error) => console.error("Failed to load 2nd floor base preview:", error));
}

export async function showThirdFloorWallPreview(): Promise<void> {
  const token = thirdFloorLoadingPreviewToken;
  const baseWall = await ensureThirdFloorLoadingBaseWall();
  if (token !== thirdFloorLoadingPreviewToken) return;
  if (models.thirdFloorLoadingBase) models.thirdFloorLoadingBase.show = true;
  baseWall.show = true;
  thirdFloorLoadingPreviewStage = "floor";
  viewer.scene.requestRender();
}

export async function showSecondFloorWallPreview(): Promise<void> {
  const token = secondFloorLoadingPreviewToken;
  const baseWall = await ensureSecondFloorLoadingBaseWall();
  if (token !== secondFloorLoadingPreviewToken) return;
  if (models.secondFloorLoadingBase) models.secondFloorLoadingBase.show = true;
  baseWall.show = true;
  secondFloorLoadingPreviewStage = "floor";
  viewer.scene.requestRender();
}

function floorFileName(floor: number): string | null {
  switch (floor) {
    case 1:
      return "ground_floor_final.glb";
    case 2:
      return "1st_floor_up_final.glb";
    case 3:
      return "final_2nd_floor_without_chair.glb";
    case 4:
      return "3rd_floor_without_chairs.glb";
    default:
      return null;
  }
}

function floorAltitude(floor: number): number {
  switch (floor) {
    case 1:
      return ALT_GROUND;
    case 2:
      return ALT_1ST;
    case 3:
      return ALT_2ND;
    case 4:
      return ALT_3RD;
    default:
      return BASE_ALT;
  }
}

export function getFloorModel(floor: number): Cesium.Model | null {
  switch (floor) {
    case 1:
      return models.ground;
    case 2:
      return models.first;
    case 3:
      return models.second;
    case 4:
      return models.third;
    default:
      return null;
  }
}

function setFloorModel(floor: number, model: Cesium.Model): void {
  switch (floor) {
    case 1:
      models.ground = model;
      break;
    case 2:
      models.first = model;
      break;
    case 3:
      models.second = model;
      break;
    case 4:
      models.third = model;
      break;
  }
}

function configureCameraModel(camera: CameraModel, index: number, floor: number): void {
  const configs2ndFloor: CameraConfig[] = [
    {
      lon: 77.133730,
      lat: 28.670906,
      height: 9.03,
      heading: 293.36,
      pitch: -45.22,
      headingMin: 277,
      headingMax: 314,
      pitchMin: -78,
      pitchMax: -29,
      fovDeg: 55,
      eyeOffsetMeters: 0
    },
    { lon: 77.133660, lat: 28.670871, height: 9.86, heading: 359.90, pitch: -60.75, fovDeg: 55, eyeOffsetMeters: 0 },
    { lon: 77.133629, lat: 28.670932, height: 9.13, heading: 64.73, pitch: -79.38 },
    { lon: 77.133595, lat: 28.670980, height: 8.00, heading: 7, pitch: -61 },
    { lon: 77.133654, lat: 28.671010, height: 11.30, heading: 179.47, pitch: -50.29 },
    { lon: 77.133730, lat: 28.670906, height: 8.50, heading: 2.29, pitch: -33.10, fovDeg: 55, eyeOffsetMeters: 0 }
  ];

  const configs3rdFloor: CameraConfig[] = [
    {
      lon: 77.133613,
      lat: 28.670938,
      height: ALT_3RD + 1.8,
      heading: 107,
      pitch: -33,
      headingMin: 90,
      headingMax: 171,
      pitchMin: -60,
      pitchMax: -10,
      fovDeg: 120
    },
    { lon: 77.133668, lat: 28.670870, height: ALT_3RD + 1.8, heading: 8, pitch: -32 },
    {
      lon: 77.13370575798822,
      lat: 28.67090204621658,
      height: ALT_3RD + 3.5,
      heading: 90,
      pitch: -20,
      fovDeg: 140
    },
    {
      lon: 77.133725,
      lat: 28.670971,
      height: ALT_3RD + 3.0,
      heading: 289,
      pitch: -30,
      headingMin: 272,
      headingMax: 290,
      pitchMin: -60,
      pitchMax: -28
    },
    {
      lon: 77.133740,
      lat: 28.670960,
      height: ALT_3RD + 1.8,
      heading: 180,
      pitch: -36,
      headingMin: 165,
      headingMax: 205,
      pitchMin: -60,
      pitchMax: -20,
      fovDeg: 120,
    },
    {
      lon: 77.133700,
      lat: 28.670897,
      height: ALT_3RD + 2.0,
      heading: 348,
      pitch: -40,
      headingMin: 331,
      headingMax: 348,
      pitchMin: -60,
      pitchMax: -10,
      fovDeg: 120
    },
    {
      lon: 77.133682,
      lat: 28.671034,
      height: ALT_3RD + 2.3,
      heading: 200,
      pitch: -37,
      headingMin: 150,
      headingMax: 250,
      pitchMin: -60,
      pitchMax: -37,
      fovDeg: 110
    },
    {
      lon: 77.133595,
      lat: 28.670980,
      height: ALT_3RD + 2.2,
      heading: 83,
      pitch: -54,
      headingMin: 60,
      headingMax: 150,
      pitchMin: -60,
      pitchMax: -35,
      fovDeg: 110
    },
    {
      lon: 77.133663,
      lat: 28.670975,
      height: 11.55,
      heading: 61,
      pitch: -56,
      headingMin: 45,
      headingMax: 73,
      pitchMin: -85,
      pitchMax: -45,
      fovDeg: 110
    }
  ];

  const configs = floor === 3 ? configs2ndFloor : configs3rdFloor;
  const config = configs[index] || configs[0];

  camera.isCamera = true;
  camera.cameraName = FLOOR_CAMERAS[floor]?.[index]?.name || `Camera ${index + 1}`;
  camera.cameraFloor = floor;
  camera.cameraConfig = config;
}

export function isFloorModelLoaded(floor: number): boolean {
  return Boolean(getFloorModel(floor)) && ((floor === 3 || floor === 4) ? models.cameras.some((camera) => camera.cameraFloor === floor) : true);
}

export function ensureFloorModelLoaded(floor: number): Promise<void> {
  if (floor < 1 || floor > 4 || isFloorModelLoaded(floor)) return Promise.resolve();

  const cached = floorLoadPromises.get(floor);
  if (cached) return cached;

  const promise = (async () => {
    const fileName = floorFileName(floor);
    if (!fileName) return;

    // Load and register the floor model first so it appears before cameras upload
    const existingFloor = getFloorModel(floor);
    if (!existingFloor) {
      const floorModel = await loadModel(fileName, floorAltitude(floor));
      setFloorModel(floor, floorModel);
      addPrimitiveHidden(floorModel);
    }

    // Load cameras one-at-a-time to avoid hammering the GPU with 7 simultaneous
    // uploads — the previous Promise.all approach caused WebGL context loss.
    if (floor === 3 && !models.cameras.some((camera) => camera.cameraFloor === 3)) {
      const cameraFiles = ["2nd_cc1.glb", "2nd_cc2.glb", "2nd_cc3.glb", "2nd_cc5.glb", "2nd_cc4.glb", "2nd_cc6.glb"];
      for (let i = 0; i < cameraFiles.length; i++) {
        const cam = await loadModel(cameraFiles[i], ALT_2ND, { allowPicking: true }) as CameraModel;
        configureCameraModel(cam, i, 3);
        models.cameras.push(cam);
        addPrimitiveHidden(cam);
      }
    } else if (floor === 4 && !models.cameras.some((camera) => camera.cameraFloor === 4)) {
      if (!models.thirdFloorPiller) {
        const piller = await loadModel("3rd_floor_piller.glb", ALT_3RD);
        models.thirdFloorPiller = piller;
        addPrimitiveHidden(piller);
      }

      const cameraFiles = ["3rd_cc1.glb", "3rd_cc2.glb", "3rd_cc3.glb", "3rd_cc4.glb", "3rd_cc5.glb", "3rd_cc6.glb", "3rd_cc6 (1).glb", "3rd_cc_meeting_room.glb", "3rd_cc8.glb"];
      for (let i = 0; i < cameraFiles.length; i++) {
        const cam = await loadModel(cameraFiles[i], ALT_3RD, { allowPicking: true }) as CameraModel;
        configureCameraModel(cam, i, 4);
        models.cameras.push(cam);
        addPrimitiveHidden(cam);
      }
      models.meetingRoom = getCameraByName("Meeting Room Cam", 4);
    }
  })().catch((error) => {
    floorLoadPromises.delete(floor);
    throw error;
  });

  floorLoadPromises.set(floor, promise);
  return promise;
}

const CCTV_VIEW_ZOOM_OUT_METERS = 12;
const CCTV_VIEW_LOOK_AHEAD_METERS = 8;
const CCTV_VIEW_UPWARD_LIFT_METERS = 1.2;
const CCTV_VIEW_DURATION_SECONDS = 1.2;

export async function loadModels(): Promise<void> {
  console.log("Loading core building models...");
  try {
    const [fullBuilding, outdoor] = await Promise.all([
      loadModel("full_building_opt.glb", BASE_ALT),
      loadModel("outdoor_model.glb", BASE_ALT)
    ]);
    models.fullBuilding = fullBuilding;
    models.outdoor = outdoor;

    addPrimitiveHidden(fullBuilding);
    addPrimitiveHidden(outdoor);
    console.log("Core building models loaded successfully.");
  } catch (error) {
    console.error("Failed to load building models:", error);
    throw error;
  }
}

export function getPickedCamera(position: Cesium.Cartesian2): CameraModel | null {
  const pickedObjects = viewer.scene.drillPick(position, 10, 5, 5);
  for (const picked of pickedObjects) {
    const primitive = picked.primitive as CameraModel | undefined;
    if (primitive?.isCamera) {
      return primitive;
    }
  }
  return null;
}

export function getCameraByName(name: string, floor?: number): CameraModel | null {
  const candidates = floor === undefined
    ? models.cameras
    : models.cameras.filter((camera) => camera.cameraFloor === floor);
  const exactName = name.trim().toUpperCase();

  const exactMatch = candidates.find((camera) => (camera.cameraName || "").trim().toUpperCase() === exactName);
  if (exactMatch) return exactMatch;

  // Match numeric fallback only for generic names like "Camera 3".
  const digits = name.match(/\d+/)?.[0];
  const isGenericCameraName = /^CAMERA\s+\d+$/i.test(name.trim());
  if (!digits || !isGenericCameraName) return null;

  return candidates.find((camera) => (camera.cameraName || "").toUpperCase().endsWith(digits)) ?? null;
}



function getWorldDirectionFromHeadingPitch(
  origin: Cesium.Cartesian3,
  heading: number,
  pitch: number
): { direction: Cesium.Cartesian3; localUp: Cesium.Cartesian3 } {
  const eastNorthUp = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
  const localDirection = new Cesium.Cartesian3(
    Math.sin(heading) * Math.cos(pitch),
    Math.cos(heading) * Math.cos(pitch),
    Math.sin(pitch)
  );
  const direction = Cesium.Matrix4.multiplyByPointAsVector(eastNorthUp, localDirection, new Cesium.Cartesian3());
  const localUp = Cesium.Matrix4.multiplyByPointAsVector(eastNorthUp, Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3());

  Cesium.Cartesian3.normalize(direction, direction);
  Cesium.Cartesian3.normalize(localUp, localUp);

  return { direction, localUp };
}

function getCameraUpVector(direction: Cesium.Cartesian3, localUp: Cesium.Cartesian3): Cesium.Cartesian3 {
  const right = Cesium.Cartesian3.cross(direction, localUp, new Cesium.Cartesian3());
  if (Cesium.Cartesian3.magnitudeSquared(right) < 0.000001) {
    return Cesium.Cartesian3.clone(localUp, new Cesium.Cartesian3());
  }

  Cesium.Cartesian3.normalize(right, right);
  const up = Cesium.Cartesian3.cross(right, direction, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(up, up);
  return up;
}

// ── CCTV Mode ────────────────────────────────────────────────────────────────

const CCTV_FOV_RAD = Cesium.Math.toRadians(90);
const CCTV_PITCH_MIN = -85;
const CCTV_PITCH_MAX = 10;

let cctvActive = false;
let cctvReady = false;
let cctvIsTweening = false;
let cctvPosition: Cesium.Cartesian3 | null = null;
let cctvHeadingDeg = 0;
let cctvPitchDeg = 0;
let cctvHeadingMinDeg: number | null = null;
let cctvHeadingMaxDeg: number | null = null;
let cctvPitchMinDeg = CCTV_PITCH_MIN;
let cctvPitchMaxDeg = CCTV_PITCH_MAX;
let cctvFovRad = CCTV_FOV_RAD;
let onCctvStateChange: ((h: number, p: number) => void) | null = null;
let cctvCameraModel: CameraModel | null = null;
let cctvDefaultPosition: Cesium.Cartesian3 | null = null;
let cctvDefaultHeadingDeg = 0;
let cctvDefaultPitchDeg = 0;

// Saved outdoor state to restore on exit
let savedGlobeShow = true;
let savedSkyAtmosphereShow = true;
let savedBackgroundColor: Cesium.Color = Cesium.Color.BLACK;
let savedControllerInputs = true;
let savedControllerZoom = true;
let savedControllerTranslate = true;
let savedControllerTilt = true;
let savedControllerLook = true;
let savedControllerRotate = true;

export function isCctvActive(): boolean {
  return cctvActive;
}

export function getActiveCctvModel(): CameraModel | null {
  return cctvCameraModel;
}

export function getCctvHeading(): number {
  return cctvHeadingDeg;
}

export function getCctvPitch(): number {
  return cctvPitchDeg;
}

function applyCctvCamera(): void {
  if (!cctvPosition || !cctvReady) return;
  const heading = Cesium.Math.toRadians(cctvHeadingDeg);
  const pitch = Cesium.Math.toRadians(cctvPitchDeg);
  const { direction, localUp } = getWorldDirectionFromHeadingPitch(cctvPosition, heading, pitch);
  const up = getCameraUpVector(direction, localUp);
  viewer.camera.setView({ destination: cctvPosition, orientation: { direction, up } });
  if (viewer.camera.frustum instanceof Cesium.PerspectiveFrustum) {
    (viewer.camera.frustum as Cesium.PerspectiveFrustum).fov = cctvFovRad;
  }
  viewer.scene.requestRender();
  onCctvStateChange?.(cctvHeadingDeg, cctvPitchDeg);
}

function clampCctvHeading(heading: number): number {
  const normalized = ((heading % 360) + 360) % 360;
  if (cctvHeadingMinDeg === null || cctvHeadingMaxDeg === null) return normalized;
  if (cctvHeadingMinDeg === cctvHeadingMaxDeg) return cctvHeadingMinDeg;
  return Math.max(cctvHeadingMinDeg, Math.min(cctvHeadingMaxDeg, normalized));
}

export function enterCctvMode(
  config: CameraConfig,
  onStateChange: (h: number, p: number) => void,
  cameraModel?: CameraModel
): void {
  const wasCctvActive = cctvActive;
  cctvActive = true;
  cctvReady = false;
  cctvIsTweening = false;
  cctvPosition = Cesium.Cartesian3.fromDegrees(config.lon, config.lat, config.height);
  cctvHeadingMinDeg = config.headingMin ?? null;
  cctvHeadingMaxDeg = config.headingMax ?? null;
  cctvPitchMinDeg = config.pitchMin ?? CCTV_PITCH_MIN;
  cctvPitchMaxDeg = config.pitchMax ?? CCTV_PITCH_MAX;
  cctvFovRad = Cesium.Math.toRadians(config.fovDeg ?? 85);
  cctvHeadingDeg = clampCctvHeading(config.heading);
  cctvPitchDeg = Math.max(cctvPitchMinDeg, Math.min(cctvPitchMaxDeg, config.pitch));
  onCctvStateChange = onStateChange;

  // Restore previous camera model visibility before switching
  if (cctvCameraModel) cctvCameraModel.show = true;
  cctvCameraModel = cameraModel ?? null;
  if (cctvCameraModel) cctvCameraModel.show = false;

  const controller = viewer.scene.screenSpaceCameraController;
  if (!wasCctvActive) {
    savedControllerInputs = controller.enableInputs;
    savedControllerZoom = controller.enableZoom;
    savedControllerTranslate = controller.enableTranslate;
    savedControllerTilt = controller.enableTilt;
    savedControllerLook = controller.enableLook;
    savedControllerRotate = controller.enableRotate;
  }
  controller.enableInputs = false;
  controller.enableZoom = false;
  controller.enableTranslate = false;
  controller.enableTilt = false;
  controller.enableLook = false;
  controller.enableRotate = false;

  // Hide outdoor world — only indoor model geometry should be visible
  if (!wasCctvActive) {
    savedGlobeShow = viewer.scene.globe.show;
    savedSkyAtmosphereShow = viewer.scene.skyAtmosphere?.show ?? true;
    savedBackgroundColor = viewer.scene.backgroundColor.clone();
  }
  viewer.scene.globe.show = false;
  if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false;
  viewer.scene.backgroundColor = Cesium.Color.BLACK;

  // Use clamped heading/pitch for the initial view (matches stored state)
  const headingRad = Cesium.Math.toRadians(cctvHeadingDeg);
  const pitchRad = Cesium.Math.toRadians(cctvPitchDeg);
  const { direction } = getWorldDirectionFromHeadingPitch(cctvPosition, headingRad, pitchRad);

  // Shift eye 0.2 m forward so the hidden camera model body is behind the lens
  const forwardOffset = Cesium.Cartesian3.multiplyByScalar(direction, config.eyeOffsetMeters ?? 0.2, new Cesium.Cartesian3());
  Cesium.Cartesian3.add(cctvPosition, forwardOffset, cctvPosition);
  cctvDefaultPosition = cctvPosition.clone();
  cctvDefaultHeadingDeg = cctvHeadingDeg;
  cctvDefaultPitchDeg = cctvPitchDeg;

  viewer.camera.setView({
    destination: cctvPosition,
    orientation: {
      heading: Cesium.Math.toRadians(cctvHeadingDeg),
      pitch: Cesium.Math.toRadians(cctvPitchDeg),
      roll: 0
    }
  });

  if (viewer.camera.frustum instanceof Cesium.PerspectiveFrustum) {
    (viewer.camera.frustum as Cesium.PerspectiveFrustum).fov = cctvFovRad;
  }
  cctvReady = true;
  viewer.scene.requestRender();
  onCctvStateChange?.(cctvHeadingDeg, cctvPitchDeg);
}

export function exitCctvMode(): void {
  cctvActive = false;
  cctvReady = false;
  cctvIsTweening = false;
  cctvPosition = null;
  cctvHeadingMinDeg = null;
  cctvHeadingMaxDeg = null;
  cctvPitchMinDeg = CCTV_PITCH_MIN;
  cctvPitchMaxDeg = CCTV_PITCH_MAX;
  cctvFovRad = CCTV_FOV_RAD;
  cctvDefaultPosition = null;
  cctvDefaultHeadingDeg = 0;
  cctvDefaultPitchDeg = 0;
  onCctvStateChange = null;
  if (cctvCameraModel) { cctvCameraModel.show = true; cctvCameraModel = null; }

  const controller = viewer.scene.screenSpaceCameraController;
  controller.enableInputs = savedControllerInputs;
  controller.enableZoom = savedControllerZoom;
  controller.enableTranslate = savedControllerTranslate;
  controller.enableTilt = savedControllerTilt;
  controller.enableLook = savedControllerLook;
  controller.enableRotate = savedControllerRotate;
  if (viewer.camera.frustum instanceof Cesium.PerspectiveFrustum) {
    (viewer.camera.frustum as Cesium.PerspectiveFrustum).fov = Cesium.Math.toRadians(60);
  }

  // Restore outdoor world
  viewer.scene.globe.show = savedGlobeShow;
  if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = savedSkyAtmosphereShow;
  viewer.scene.backgroundColor = savedBackgroundColor;

  viewer.scene.requestRender();
}

export function setCctvHeading(deltaDeg: number): void {
  if (!cctvActive || !cctvReady || cctvIsTweening) return;
  cctvHeadingDeg = clampCctvHeading(cctvHeadingDeg + deltaDeg);
  applyCctvCamera();
}

export function setCctvPitch(deltaDeg: number): void {
  if (!cctvActive || !cctvReady) return;
  cctvPitchDeg = Math.max(cctvPitchMinDeg, Math.min(cctvPitchMaxDeg, cctvPitchDeg + deltaDeg));
  applyCctvCamera();
}

export function resetCctvDefaultView(): void {
  if (!cctvActive || !cctvReady || !cctvDefaultPosition) return;
  cctvPosition = cctvDefaultPosition.clone();
  cctvHeadingDeg = cctvDefaultHeadingDeg;
  cctvPitchDeg = cctvDefaultPitchDeg;
  applyCctvCamera();
}

export function setCctvZoom(zoomIn: boolean): void {
  if (!cctvActive || !cctvReady) return;
  const zoomStep = Cesium.Math.toRadians(5);
  if (zoomIn) {
    cctvFovRad = Math.max(Cesium.Math.toRadians(10), cctvFovRad - zoomStep);
  } else {
    cctvFovRad = Math.min(Cesium.Math.toRadians(120), cctvFovRad + zoomStep);
  }
  applyCctvCamera();
}

export function getCctvDebugInfo(): {
  position: { lon: number; lat: number; height: number };
  heading: number;
  pitch: number;
  fov: number;
  direction: string;
} | null {
  if (!cctvPosition) return null;
  const cartographic = Cesium.Cartographic.fromCartesian(cctvPosition);
  const lon = Cesium.Math.toDegrees(cartographic.longitude);
  const lat = Cesium.Math.toDegrees(cartographic.latitude);
  const height = cartographic.height;
  const fov = Cesium.Math.toDegrees(cctvFovRad);

  const headingNorm = ((cctvHeadingDeg % 360) + 360) % 360;
  let direction = "N";
  if (headingNorm >= 337.5 || headingNorm < 22.5) direction = "North";
  else if (headingNorm < 67.5) direction = "NE";
  else if (headingNorm < 112.5) direction = "East";
  else if (headingNorm < 157.5) direction = "SE";
  else if (headingNorm < 202.5) direction = "South";
  else if (headingNorm < 247.5) direction = "SW";
  else if (headingNorm < 292.5) direction = "West";
  else direction = "NW";

  return {
    position: { lon, lat, height },
    heading: cctvHeadingDeg,
    pitch: cctvPitchDeg,
    fov,
    direction
  };
}



export function showCameraView(cameraConfig: CameraConfig): void {
  const cameraPoint = Cesium.Cartesian3.fromDegrees(cameraConfig.lon, cameraConfig.lat, cameraConfig.height);
  const heading = Cesium.Math.toRadians(cameraConfig.heading);
  const pitch = Cesium.Math.toRadians(cameraConfig.pitch);
  const { direction, localUp } = getWorldDirectionFromHeadingPitch(cameraPoint, heading, pitch);
  const zoomOutDistance = cameraConfig.zoomOutDistance ?? CCTV_VIEW_ZOOM_OUT_METERS;
  const lookAheadDistance = cameraConfig.lookAheadDistance ?? CCTV_VIEW_LOOK_AHEAD_METERS;
  const upwardLift = cameraConfig.upwardLift ?? CCTV_VIEW_UPWARD_LIFT_METERS;

  const backwardOffset = Cesium.Cartesian3.multiplyByScalar(direction, -zoomOutDistance, new Cesium.Cartesian3());
  const upwardOffset = Cesium.Cartesian3.multiplyByScalar(localUp, upwardLift, new Cesium.Cartesian3());
  const destination = Cesium.Cartesian3.add(cameraPoint, backwardOffset, new Cesium.Cartesian3());
  Cesium.Cartesian3.add(destination, upwardOffset, destination);

  const target = Cesium.Cartesian3.add(
    cameraPoint,
    Cesium.Cartesian3.multiplyByScalar(direction, lookAheadDistance, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  );
  const viewDirection = Cesium.Cartesian3.subtract(target, destination, new Cesium.Cartesian3());
  Cesium.Cartesian3.normalize(viewDirection, viewDirection);

  viewer.camera.flyTo({
    destination,
    orientation: {
      direction: viewDirection,
      up: getCameraUpVector(viewDirection, localUp)
    },
    duration: CCTV_VIEW_DURATION_SECONDS,
    complete: () => viewer.scene.requestRender(),
    cancel: () => viewer.scene.requestRender()
  });
}

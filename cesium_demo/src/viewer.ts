import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";

export * as Cesium from "cesium";

const ionToken = import.meta.env.VITE_CESIUM_ION_TOKEN;
if (ionToken) {
  Cesium.Ion.defaultAccessToken = ionToken;
}

export const viewer = new Cesium.Viewer("cesiumContainer", {
  terrainProvider: undefined,
  baseLayerPicker: true,
  geocoder: false,
  homeButton: false,
  sceneModePicker: false,
  navigationHelpButton: false,
  shadows: false,
  shouldAnimate: true,
  infoBox: false,
  selectionIndicator: false,
  animation: false,
  timeline: false,
  requestRenderMode: true,
  maximumRenderTimeChange: 0,
  msaaSamples: 1  // 4→1: cuts framebuffer GPU memory by 4× (prevents context loss under load)
} as Cesium.Viewer.ConstructorOptions);

viewer.scene.screenSpaceCameraController.minimumZoomDistance = 0.5;
viewer.scene.screenSpaceCameraController.maximumZoomDistance = 20000.0;
(viewer.scene.screenSpaceCameraController as any).minimumPitch = Cesium.Math.toRadians(-85);
(viewer.scene.screenSpaceCameraController as any).maximumPitch = Cesium.Math.toRadians(-5);
viewer.scene.postProcessStages.fxaa.enabled = true;
viewer.resolutionScale = Math.min(window.devicePixelRatio, 1.5);
viewer.scene.fog.enabled = false;
if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = false;
// Indoor-friendly brightness
viewer.scene.globe.enableLighting = false;
viewer.shadows = false;
viewer.terrainShadows = Cesium.ShadowMode.DISABLED;

// Avoid darker HDR contrast
(viewer.scene as any).highDynamicRange = false;

// Stronger neutral light keeps indoor-facing GLB surfaces from going muddy.
viewer.scene.light = new Cesium.SunLight({
  color: Cesium.Color.WHITE,
  intensity: 4.4
});

export const DEFAULT_AMBIENT_LIGHT = new Cesium.Color(1.4, 1.42, 1.48, 1.0);
export const SECOND_FLOOR_COOL_AMBIENT_LIGHT = new Cesium.Color(1.6, 1.67, 1.83, 1.0);
export const INDOOR_MODEL_LIGHT_COLOR = new Cesium.Cartesian3(2.25, 2.3, 2.45);

export function createIndoorImageBasedLighting(): Cesium.ImageBasedLighting {
  const imageBasedLighting = new Cesium.ImageBasedLighting();
  imageBasedLighting.imageBasedLightingFactor = new Cesium.Cartesian2(0.65, 0.25);
  return imageBasedLighting;
}

// Brighter ambient for indoor GLB floors/objects
(viewer.scene as any).ambientLightColor = DEFAULT_AMBIENT_LIGHT;

// Fixed time so lighting does not change
viewer.clock.currentTime = Cesium.JulianDate.fromDate(
  new Date(new Date().setHours(12, 0, 0, 0))
);

// Stop time from moving, so brightness remains stable
viewer.clock.shouldAnimate = false;
viewer.clock.multiplier = 0;

if (viewer.scene.skyBox) {
  (viewer.scene.skyBox as any).show = false;
}

viewer.scene.globe.show = true;

if (viewer.scene.shadowMap) {
  (viewer.scene.shadowMap as any).enabled = false;
  viewer.scene.shadowMap.darkness = 0.0;
  viewer.scene.shadowMap.softShadows = false;
}

const osmLayer = new Cesium.UrlTemplateImageryProvider({
  url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  subdomains: ["a", "b", "c"]
});

viewer.imageryLayers.removeAll();
viewer.imageryLayers.addImageryProvider(osmLayer);

if (viewer.baseLayerPicker) {
  viewer.baseLayerPicker.viewModel.imageryProviderViewModels = [
    new Cesium.ProviderViewModel({
      name: "OpenStreetMap",
      iconUrl: "https://a.tile.openstreetmap.org/2/2/1.png",
      tooltip: "OpenStreetMap",
      creationFunction: () =>
        new Cesium.UrlTemplateImageryProvider({
          url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
          subdomains: ["a", "b", "c"]
        })
    }),
    new Cesium.ProviderViewModel({
      name: "Satellite",
      iconUrl: "https://mt1.google.com/vt/lyrs=s&x=2&y=1&z=2",
      tooltip: "Satellite Imagery",
      creationFunction: () =>
        new Cesium.UrlTemplateImageryProvider({
          url: "https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}"
        })
    }),
    new Cesium.ProviderViewModel({
      name: "Google Maps",
      iconUrl: "https://mt1.google.com/vt/lyrs=m&x=2&y=1&z=2",
      tooltip: "Google Maps Road",
      creationFunction: () =>
        new Cesium.UrlTemplateImageryProvider({
          url: "https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}"
        })
    }),
    new Cesium.ProviderViewModel({
      name: "Hybrid",
      iconUrl: "https://mt1.google.com/vt/lyrs=y&x=2&y=1&z=2",
      tooltip: "Satellite + Roads",
      creationFunction: () =>
        new Cesium.UrlTemplateImageryProvider({
          url: "https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}"
        })
    })
  ];

  viewer.baseLayerPicker.viewModel.terrainProviderViewModels = [];

  const sectionTitle = viewer.baseLayerPicker.container.querySelector(".cesium-baseLayerPicker-sectionTitle");
  if (sectionTitle) sectionTitle.textContent = "Layers";
}

export const routeArrowCollection = viewer.scene.primitives.add(new Cesium.BillboardCollection());

export const LONGITUDE = 77.13369474110053 + 0.0000053;
export const LATITUDE = 28.670948042901436 + 0.00001684;
export const MODEL_SCALE = 25;
export const BASE_ALT = 0.01;
export const FLOOR_H = 3.6;
export const STACK_COMPRESS = -0.6;
export const ALT_GROUND = BASE_ALT;
export const ALT_1ST = BASE_ALT + FLOOR_H + STACK_COMPRESS;
export const ALT_2ND = BASE_ALT + 2 * FLOOR_H + 2 * STACK_COMPRESS;
export const ALT_3RD = BASE_ALT + 3 * FLOOR_H + 3 * STACK_COMPRESS;

const yaw = 50;
const pitch = -139;
const roll = -90;

export function computeMatrix(altitude: number, zOffset = 0): Cesium.Matrix4 {
  const position = Cesium.Cartesian3.fromDegrees(LONGITUDE, LATITUDE, altitude);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(position);
  const rz = Cesium.Matrix3.fromRotationZ(Cesium.Math.toRadians(yaw));
  const rx = Cesium.Matrix3.fromRotationX(Cesium.Math.toRadians(pitch));
  const ry = Cesium.Matrix3.fromRotationY(Cesium.Math.toRadians(roll));
  const rotation = Cesium.Matrix3.multiply(
    rz,
    Cesium.Matrix3.multiply(ry, rx, new Cesium.Matrix3()),
    new Cesium.Matrix3()
  );
  const rotated = Cesium.Matrix4.fromRotationTranslation(rotation);
  const shifted = Cesium.Matrix4.clone(rotated, new Cesium.Matrix4());
  Cesium.Matrix4.multiplyByTranslation(shifted, new Cesium.Cartesian3(0, 0, zOffset), shifted);

  const result = new Cesium.Matrix4();
  Cesium.Matrix4.multiply(enu, shifted, result);
  return result;
}

export function waitForRender(): Promise<void> {
  return new Promise((resolve) => {
    const remove = viewer.scene.postRender.addEventListener(() => {
      remove();
      resolve();
    });
    viewer.scene.requestRender();
  });
}

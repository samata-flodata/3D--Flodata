import {
  Cesium,
  ALT_2ND,
  ALT_3RD,
  INDOOR_MODEL_LIGHT_COLOR,
  MODEL_SCALE,
  computeMatrix,
  createIndoorImageBasedLighting,
  viewer
} from "./viewer";
import { modelUrl } from "./models";

export interface ChairModel extends Cesium.Model {
  chairName?: string;
  chairIndex?: number;
  chairFloor?: 3 | 4;
  allowPicking: boolean;
  color: Cesium.Color;
}

export const thirdFloorChairs: ChairModel[] = [];
export const secondFloorChairs: ChairModel[] = [];
const chairLoadMap = new Map<3 | 4, Promise<void>>();
const SECOND_FLOOR_CHAIR_BATCH_SIZE = 6;
const THIRD_FLOOR_CHAIR_BATCH_SIZE = 6;
// One shared IBL object — all chairs use identical parameters so no need for 52 separate GPU allocations
const sharedIndoorIBL = createIndoorImageBasedLighting();

const thirdFloorChairNames: Record<number, string> = {
  1: "Kush",
  2: "Uthkarsh",
  3: "Nitish",
  4: "Sparsh",
  5: "Nimit",
  6: "Albin",
  7: "Vikas",
  8: "Shekhar",
  9: "Pratham",
  10: "Jay",
  11: "Desk Chair D",
  12: "Desk Chair E",
  13: "Harsh",
  14: "Vikrant",
  15: "Raghav",
  16: "Aniket",
  17: "Manav",
  18: "Pushkar",
  19: "Astami",
  20: "Carig",
  21: "Anshika",
  22: "Vanshika",
  23: "Kapil",
  24: "Rohit",
  26: "Unknown3",
  27: "Prince",
  28: "Samata",
  29: "Payel",
  30: "Akshay",
  31: "Aishwarya",
  32: "unknown6",
  33: "unknown7",
  34: "unknown4"
};

const secondFloorChairNames: Record<number, string> = {
  1: "unknown1",
  2: "Shuvankit",
  3: "unknown2",
  4: "Vidit",
  5: "Diksha",
  6: "Apoorva",
  7: "unknown3",
  8: "unknown4",
  9: "Kushi",
  10: "Vishal",
  11: "Rohit",
  12: "Vibhu",
  13: "Jiteswar",
  14: "Swati",
  15: "Chair O",
  16: "Chair P",
  17: "Ankita",
  18: "Himanshi"
};

async function loadChair(fileName: string, altitude: number, name: string, index: number, floor: 3 | 4): Promise<ChairModel> {
  const model = (await Cesium.Model.fromGltfAsync({
    url: modelUrl(fileName),
    modelMatrix: computeMatrix(altitude),
    scale: MODEL_SCALE,
    shadows: Cesium.ShadowMode.DISABLED,
    allowPicking: true,
    cull: true,
    incrementallyLoadTextures: true,
    enablePick: true,
    lightColor: INDOOR_MODEL_LIGHT_COLOR,
    imageBasedLighting: sharedIndoorIBL
  } as any)) as ChairModel;

  model.chairName = name;
  model.chairIndex = index;
  model.chairFloor = floor;
  model.id = model;
  model.show = false;
  viewer.scene.primitives.add(model);
  return model;
}

async function loadSecondFloorChairs(onChairLoaded?: (chair: ChairModel) => void): Promise<void> {
  const indexes = Array.from({ length: 18 }, (_, i) => i + 1);
  for (let start = 0; start < indexes.length; start += SECOND_FLOOR_CHAIR_BATCH_SIZE) {
    const batch = indexes.slice(start, start + SECOND_FLOOR_CHAIR_BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async (index) => {
        try {
          const model = await loadChair(
            `final_2nd_floor_${index}.glb`,
            ALT_2ND,
            secondFloorChairNames[index] ?? `2F Chair ${index}`,
            index,
            3
          );
          secondFloorChairs.push(model);
          onChairLoaded?.(model);
        } catch (error) {
          console.warn(`Missing 2nd floor chair file: final_2nd_floor_${index}.glb`, error);
        }
      })
    );
  }
}

async function loadThirdFloorChairs(onChairLoaded?: (chair: ChairModel) => void): Promise<void> {
  const indexes = Array.from({ length: 34 }, (_, i) => i + 1);
  for (let start = 0; start < indexes.length; start += THIRD_FLOOR_CHAIR_BATCH_SIZE) {
    const batch = indexes.slice(start, start + THIRD_FLOOR_CHAIR_BATCH_SIZE);
    await Promise.allSettled(
      batch.map(async (index) => {
        try {
          const model = (await Cesium.Model.fromGltfAsync({
            url: modelUrl(`${index}.glb`),
            modelMatrix: computeMatrix(ALT_3RD),
            scale: MODEL_SCALE,
            shadows: Cesium.ShadowMode.DISABLED,
            allowPicking: true,
            cull: true,
            incrementallyLoadTextures: true,
            enablePick: true,
            lightColor: INDOOR_MODEL_LIGHT_COLOR,
            imageBasedLighting: sharedIndoorIBL
          } as any)) as ChairModel;
          model.chairName = thirdFloorChairNames[index] ?? `3F Chair ${index}`;
          model.chairIndex = index;
          model.chairFloor = 4;
          model.id = model;
          model.show = false;
          viewer.scene.primitives.add(model);
          thirdFloorChairs.push(model);
          onChairLoaded?.(model);
        } catch (error) {
          console.warn(`Missing 3rd floor chair file: ${index}.glb`, error);
        }
      })
    );
  }
}

export function loadChairsForFloor(floor: number, onChairLoaded?: (chair: ChairModel) => void): Promise<void> {
  if (floor !== 3 && floor !== 4) return Promise.resolve();

  const cached = chairLoadMap.get(floor);
  if (cached) return cached;

  const promise = (floor === 3 ? loadSecondFloorChairs(onChairLoaded) : loadThirdFloorChairs(onChairLoaded))
    .catch((error) => {
      chairLoadMap.delete(floor);
      throw error;
    });
  chairLoadMap.set(floor, promise);
  return promise;
}

export async function loadChairs(onChairLoaded?: (chair: ChairModel) => void): Promise<void> {
  await loadChairsForFloor(3, onChairLoaded);
  await loadChairsForFloor(4, onChairLoaded);
}

export function getPickedChair(position: Cesium.Cartesian2): ChairModel | null {
  const pickedObjects = viewer.scene.drillPick(position, undefined, 7, 7);
  for (const picked of pickedObjects) {
    const candidates = [picked, picked?.primitive, picked?.id, picked?.model, picked?.content?.model];
    for (const candidate of candidates) {
      const model = candidate as ChairModel | undefined;
      if (model?.chairName) {
        return model;
      }
    }
  }
  return null;
}

export function highlightChair(chair: ChairModel | null, color = Cesium.Color.WHITE): void {
  if (!chair) return;
  chair.color = color;
}

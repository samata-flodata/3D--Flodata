import { Cesium, ALT_2ND, ALT_3RD, viewer } from "./viewer";
import { GlobalEvent, matchRoomName } from "./booking";
import corridor2Url from "../2nd_floor_corridor.geojson?url";
import rooms2Url from "../2nd_floor_room1.geojson?url";
import corridor3Url from "../3rd_floor_corridor.geojson?url";
import rooms3Url from "../3rd_floor_room1.geojson?url";
import door2Url from "../door_2nd.geojson?url";
import door3Url from "../door_3rd.geojson?url";

const geoJsonAssets: Record<string, string> = {
  "../2nd_floor_corridor.geojson": corridor2Url,
  "../2nd_floor_room1.geojson": rooms2Url,
  "../3rd_floor_corridor.geojson": corridor3Url,
  "../3rd_floor_room1.geojson": rooms3Url,
  "../door_2nd.geojson": door2Url,
  "../door_3rd.geojson": door3Url,
};

export const BOOKABLE_ROOMS = new Set([
  "dojo", "eureka", "manthan", "meeting room", "conference room",
]);

export let geo2: Cesium.GeoJsonDataSource | null = null;
export let geo3: Cesium.GeoJsonDataSource | null = null;

export function geoJsonUrl(fileName: string): string {
  const url = geoJsonAssets[`../${fileName}`];
  if (!url) throw new Error(`Missing GeoJSON asset: ${fileName}`);
  return url;
}

export function normalizeRoomName(name?: string | null): string {
  return name?.toLowerCase().trim() ?? "";
}

function propertyValue(entity: Cesium.Entity, key: string): string | undefined {
  const value = (entity.properties as any)?.[key];
  return typeof value?.getValue === "function" ? value.getValue() : undefined;
}

function styleRoomEntity(entity: Cesium.Entity, altitude: number): void {
  const roomName = propertyValue(entity, "room_name") ?? propertyValue(entity, "name") ?? "Room";
  const normalized = normalizeRoomName(roomName);
  
  if (BOOKABLE_ROOMS.has(normalized)) {
    entity.description = new Cesium.ConstantProperty(
      `<b>${roomName}</b><br/>Status: <span style="color:green">Available</span>`
    );
  } else {
    entity.description = new Cesium.ConstantProperty(`<b>${roomName}</b>`);
  }

  if (entity.polygon) {
    entity.polygon.height = new Cesium.ConstantProperty(altitude);
    entity.polygon.extrudedHeight = new Cesium.ConstantProperty(altitude);
    entity.polygon.material = new Cesium.ColorMaterialProperty(Cesium.Color.WHITE.withAlpha(0.05));
    entity.polygon.outline = new Cesium.ConstantProperty(true);
    entity.polygon.outlineColor = new Cesium.ConstantProperty(Cesium.Color.BLACK.withAlpha(0.05));

    const hierarchy = entity.polygon.hierarchy?.getValue(Cesium.JulianDate.now());
    const positions = hierarchy?.positions ?? [];
    if (positions.length > 0) {
      const sphere = Cesium.BoundingSphere.fromPoints(positions);
      const cartographic = Cesium.Cartographic.fromCartesian(sphere.center);
      entity.position = new Cesium.ConstantPositionProperty(
        Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, altitude + 2.0)
      );
    }
  } else if (entity.position) {
    entity.point = new Cesium.PointGraphics({
      pixelSize: 40,
      color: Cesium.Color.RED,
      outlineColor: Cesium.Color.WHITE,
      outlineWidth: 3,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    });
  }
}

async function loadGeoJSON(fileName: string, altitude: number): Promise<Cesium.GeoJsonDataSource> {
  const dataSource = await Cesium.GeoJsonDataSource.load(geoJsonUrl(fileName));
  dataSource.entities.values.forEach((entity) => styleRoomEntity(entity, altitude));
  dataSource.show = false;
  await viewer.dataSources.add(dataSource);
  return dataSource;
}

export async function loadRooms(): Promise<void> {
  console.log("Loading rooms GeoJSON...");
  try {
    [geo2, geo3] = await Promise.all([
      loadGeoJSON("2nd_floor_room1.geojson", ALT_2ND),
      loadGeoJSON("3rd_floor_room1.geojson", ALT_3RD),
    ]);
    console.log("Rooms GeoJSON loaded successfully.");
  } catch (error) {
    console.error("Failed to load rooms GeoJSON:", error);
    throw error;
  }
}

export function getNavigableRoomNames(): string[] {
  if (!geo2 || !geo3) return [];
  const rooms = [
    ...geo2.entities.values.map((entity) => ({ name: propertyValue(entity, "room_name"), floorLabel: "2nd Floor" })),
    ...geo3.entities.values.map((entity) => ({ name: propertyValue(entity, "room_name"), floorLabel: "3rd Floor" })),
  ].filter(
    (room): room is { name: string; floorLabel: string } =>
      Boolean(room.name && room.name !== "Employee sitting places" && room.name !== "Stairs")
  );

  const counts = rooms.reduce((map, room) => {
    map.set(room.name, (map.get(room.name) ?? 0) + 1);
    return map;
  }, new Map<string, number>());

  return rooms
    .map((room) => (counts.get(room.name) && counts.get(room.name)! > 1 ? `${room.name} (${room.floorLabel})` : room.name))
    .sort((a, b) => a.localeCompare(b));
}

// ── Tooltip ───────────────────────────────────────────────────────
function tooltipHTML(roomName: string, bookings: GlobalEvent[]): string {
  if (bookings.length === 0) {
    return `<b>${roomName}</b><br/>Status: <span style="color:green">Available</span>`;
  }
  const fmt = (d: Date): string =>
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const details = bookings
    .map(
      (e, i) => `
      <div style="margin-bottom:8px;">
        <b>Meeting ${i + 1}:</b> ${e.title}<br/>
        <b>By:</b> ${e.organizer}<br/>
        <b>Time:</b> ${fmt(e.start)} – ${fmt(e.end)}
      </div>`
    )
    .join("");

  return `<b>${roomName}</b><br/><hr style="margin:4px 0;border:none;border-top:1px solid #ddd;">${details}`;
}

// ── Update room availability from global events ───────────────────
export function updateRoomAvailability(events: GlobalEvent[]): void {
  const now = new Date();

  for (let i = 0; i < viewer.dataSources.length; i += 1) {
    const dataSource = viewer.dataSources.get(i);
    for (const entity of dataSource.entities.values) {
      if (!entity.polygon) continue;
      const rawName = propertyValue(entity, "room_name");
      if (!rawName) continue;
      if (!BOOKABLE_ROOMS.has(normalizeRoomName(rawName))) continue;

      const roomMatch = matchRoomName(rawName);
      if (!roomMatch) continue;

      const activeBookings = events.filter((e) => e.room === roomMatch && e.end >= now);
      entity.polygon.material = new Cesium.ColorMaterialProperty(
        Cesium.Color.WHITE.withAlpha(0.05)
      );
      entity.description = new Cesium.ConstantProperty(tooltipHTML(roomMatch, activeBookings));
    }
  }

  viewer.scene.requestRender();
}

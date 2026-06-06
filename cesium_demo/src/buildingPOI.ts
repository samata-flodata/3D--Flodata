/**
 * Central room Point-of-Interest data for the FloData Analytics building.
 *
 * Door coordinates sourced directly from:
 *   - door_2nd.geojson  (2nd floor / navigation floor 3)
 *   - door_3rd.geojson  (3rd floor / navigation floor 4)
 *
 * Floor numbering follows navigation.ts convention:
 *   floor 3 → 2nd floor (ALT_2ND)
 *   floor 4 → 3rd floor (ALT_3RD)
 */

export type RoomPOI = {
  name: string;
  floor: number;           // 3 = 2nd floor, 4 = 3rd floor
  floorLabel: string;      // "2nd Floor" | "3rd Floor"
  doorLon: number;
  doorLat: number;
  positionApproximate?: true;  // true = centroid estimate, no dedicated door entry
};

/**
 * Outdoor building entry/exit point — the exact lat/lon where:
 *   - outdoor map route stops and yields to indoor navigation
 *   - "Enter Building" prompt is shown
 *   - camera flies inside the building
 *
 * Coordinates confirmed by user from entry/exit survey (floor 3 = 2nd floor).
 */
export const BUILDING_ENTRANCE = {
  lon: 77.13370217030000,
  lat: 28.67090077990000,
  floor: 3,  // navigation floor 3 = 2nd floor (ALT_2ND)
} as const;

/** Indoor camera position just inside the entrance door (for fly-in animation). */
export const INDOOR_ENTRANCE_CAMERA = {
  lon: 77.13370217030000,
  lat: 28.67091500000000,  // slightly inside the building from entrance
  altOffset: 4.5,          // metres above floor altitude
  heading: 342,            // degrees
  pitch: -55,              // degrees
} as const;

/**
 * All known room POIs.  Coordinates from door GeoJSON files unless noted.
 *
 * TODO items are listed in ROOM_POI_TODOS below.
 */
export const ROOM_POIS: RoomPOI[] = [
  // ── 2nd Floor (navigation floor 3) ─────────────────────────────────────────
  { name: "Entrance",       floor: 3, floorLabel: "2nd Floor", doorLon: 77.13369299801327, doorLat: 28.670894822152 },
  { name: "Admin",          floor: 3, floorLabel: "2nd Floor", doorLon: 77.13366861432342, doorLat: 28.67089008887495 },
  { name: "Dojo",           floor: 3, floorLabel: "2nd Floor", doorLon: 77.13366540177487, doorLat: 28.67092944681110 },
  { name: "Director",       floor: 3, floorLabel: "2nd Floor", doorLon: 77.13369628484955, doorLat: 28.67095426028975 },
  { name: "Manthan",        floor: 3, floorLabel: "2nd Floor", doorLon: 77.13370522156849, doorLat: 28.67094925880298 },
  { name: "Eureka",         floor: 3, floorLabel: "2nd Floor", doorLon: 77.13368649275453, doorLat: 28.67098951671396 },
  { name: "UG's Cabin",     floor: 3, floorLabel: "2nd Floor", doorLon: 77.13367439510367, doorLat: 28.67100097148032 },
  { name: "VG's Cabin",     floor: 3, floorLabel: "2nd Floor", doorLon: 77.13362981197865, doorLat: 28.67096311881750 },
  { name: "Pantry",         floor: 3, floorLabel: "2nd Floor", doorLon: 77.13361505798458, doorLat: 28.67098751501402 },
  { name: "Men Washroom",   floor: 3, floorLabel: "2nd Floor", doorLon: 77.13362298925544, doorLat: 28.67099246271987 },
  { name: "Women Washroom", floor: 3, floorLabel: "2nd Floor", doorLon: 77.13365455987549, doorLat: 28.67101673869098 },

  // ── 3rd Floor (navigation floor 4) ─────────────────────────────────────────
  { name: "Entrance",        floor: 4, floorLabel: "3rd Floor", doorLon: 77.13369341274869, doorLat: 28.67089868786110 },
  { name: "Conference Room", floor: 4, floorLabel: "3rd Floor", doorLon: 77.13363876416800, doorLat: 28.67094988101015 },
  { name: "Meeting Room",    floor: 4, floorLabel: "3rd Floor", doorLon: 77.13366405005728, doorLat: 28.67101321416699 },
  { name: "Pantry",          floor: 4, floorLabel: "3rd Floor", doorLon: 77.13371705946003, doorLat: 28.67095703850098 },
  { name: "Men Washroom",    floor: 4, floorLabel: "3rd Floor", doorLon: 77.13365135034559, doorLat: 28.67101546237399 },
  { name: "Women Washroom",  floor: 4, floorLabel: "3rd Floor", doorLon: 77.13362922745107, doorLat: 28.67100052355134 },
  // Library has no dedicated door in door_3rd.geojson — position is polygon centroid.
  { name: "Library",         floor: 4, floorLabel: "3rd Floor", doorLon: 77.13365455, doorLat: 28.67090062, positionApproximate: true },
];

/**
 * Rooms whose door coordinate is missing or approximate.
 * Add the real entry point to door_3rd.geojson (or door_2nd.geojson) and
 * update the corresponding ROOM_POIS entry to remove positionApproximate.
 */
export const ROOM_POI_TODOS: string[] = [
  "Library (3rd Floor): No door entry in door_3rd.geojson. " +
  "Current position is polygon centroid (lon=77.13365455, lat=28.67090062). " +
  "Survey the actual door and add a Point feature with room_name='Library' to door_3rd.geojson.",
];

/**
 * Find the best-matching RoomPOI for a raw dropdown/input string.
 *
 * Handles:
 *   - plain names:                "Manthan"
 *   - floor-suffixed labels:      "Pantry (2nd Floor)"
 *   - case-insensitive matching
 */
export function lookupRoomPOI(rawName: string): RoomPOI | null {
  if (!rawName) return null;

  const floorTag = rawName.match(/(?:\(|\b)(\d+(?:nd|rd|th|st))\s+Floor(?:\)|\b)/i)?.[1]?.toLowerCase();
  const baseName = rawName
    .replace(/\s*\([^)]*Floor[^)]*\)/gi, "")
    .replace(/\b\d+(?:nd|rd|th|st)\s+Floor\b/gi, "")
    .trim()
    .toLowerCase();

  for (const poi of ROOM_POIS) {
    if (poi.name.toLowerCase() !== baseName) continue;
    if (floorTag) {
      if (poi.floorLabel.toLowerCase().startsWith(floorTag)) return poi;
    } else {
      return poi;
    }
  }
  return null;
}

/** True if the query string matches any known room POI name. */
export function isRoomQuery(query: string): boolean {
  return lookupRoomPOI(query) !== null;
}

// Log TODO items once at module load so they are visible in the console.
if (ROOM_POI_TODOS.length > 0) {
  console.group("[buildingPOI] Room coordinate TODOs");
  ROOM_POI_TODOS.forEach((item) => console.warn(item));
  console.groupEnd();
}

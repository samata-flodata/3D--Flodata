# Cesium Attendance MVP

This project has a Vite/Cesium frontend and a small Express backend for attendance tracking.

Attendance flow:

- Google Login identifies the user in the frontend.
- The browser watches mobile GPS with `navigator.geolocation.watchPosition`.
- The frontend detects building entry/exit using a geofence.
- Sign-in is allowed only from 09:30 to 19:30 IST.
- If the user is still signed in at 19:30 IST, attendance signs out automatically.
- The frontend calls the backend attendance APIs.
- The backend writes attendance rows to Google Sheets using a service account.

## Google Sheet

The sheet must have a tab named `Attendance` with these columns in row 1:

```text
Email, Name, SignInTime, SignOutTime, TotalMinutes, Latitude, Longitude, Accuracy, Date, Status
```

Share the spreadsheet with the service account email from `server/service-account.json`. Give it Editor access.

## Backend Setup

Install dependencies:

```bash
cd server
npm install
```

Place the service account key at:

```text
server/service-account.json
```

The file is ignored by Git and must not be committed.

Create `server/.env`:

```env
PORT=5000
SPREADSHEET_ID=1WWLKkv8saZsMA7WgCv5j_Wnu5wJBaR8q9Mwz-v9TqYA
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
SHEET_NAME=Attendance
CORS_ORIGIN=http://localhost:5173,http://localhost:5500
ATTENDANCE_BUILDING_LAT=28.670903
ATTENDANCE_BUILDING_LNG=77.133783
ATTENDANCE_ENTER_RADIUS_METERS=100
ATTENDANCE_EXIT_RADIUS_METERS=100
ATTENDANCE_MAX_ACCURACY_METERS=100
ATTENDANCE_REQUIRED_SAMPLES=3
ATTENDANCE_REQUIRED_DURATION_MS=5000
ATTENDANCE_MAX_SPEED_KMH=150
ATTENDANCE_MAX_SAMPLE_SPREAD_METERS=50
```

Run the backend:

```bash
cd server
npm start
```

Health check:

```bash
curl http://localhost:5000/health
```

## Frontend Setup

Install frontend dependencies:

```bash
cd cesium_demo
npm install
```

Run the frontend:

```bash
cd cesium_demo
npm run dev
```

Optional frontend env:

```env
VITE_ATTENDANCE_API_BASE_URL=http://localhost:5000
VITE_ATTENDANCE_BUILDING_LAT=28.670903
VITE_ATTENDANCE_BUILDING_LON=77.133783
VITE_ATTENDANCE_ENTER_RADIUS_METERS=100
VITE_ATTENDANCE_EXIT_RADIUS_METERS=100
VITE_ATTENDANCE_MAX_ACCURACY_METERS=100
```

## Test Attendance API

Sign in:

```bash
curl -X POST http://localhost:5000/api/attendance/signin \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"test@example.com\",\"name\":\"Test User\",\"lat\":28.670903,\"lng\":77.133783,\"accuracy\":12}"
```

Sign out:

```bash
curl -X POST http://localhost:5000/api/attendance/signout \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"test@example.com\",\"lat\":28.670950,\"lng\":77.133800,\"accuracy\":14}"
```

## Notes

- Do not expose `service-account.json` in the frontend.
- Google Sheets API calls are made only from the Express backend.
- The frontend only calls `/api/attendance/signin` and `/api/attendance/signout`.
- GPS accuracy indoors can be poor. Current laptop testing allows readings up to `100m` accuracy, requires 3 consistent samples over at least 5 seconds, and rejects suspicious speed/location jumps.

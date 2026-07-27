# FaceScan - Student Face Scanner Attendance System

A high-fidelity mobile application for student face recognition enrollment and automated attendance logging. Built with **React Native / Expo** and powered by a lightweight **Node.js Express** backend.

---

## 📱 Key Features

* **📷 Live Viewfinder Scanner**: Start screen features a full-screen camera preview stream with live simulated face recognition match overlays.
* **🔐 Admin Authentication Gate**: Secure credentials checking offloaded to an Express backend.
* **⚡ Staggered Layout Transitions**: Smooth staggered entrance animations powered by `react-native-reanimated`.
* **📳 Premium Haptic Feedback**: Tactile click controls and status vibration signals powered by `expo-haptics`.
* **⚙️ Persistent Configuration Panel**: Administrative settings menu for camera toggles and haptic preferences persisted using `AsyncStorage`.
* **📊 Class Roster & Log Audits**: Responsive class lists with accordion menus and today's attendance logs tracking late/present states.

---

## 🛠️ Tech Stack

* **Frontend**: React Native, Expo SDK 52, Expo Router, NativeWind (Tailwind CSS v4), React Native Reanimated, Expo Haptics, React Native SVG.
* **Backend**: Node.js, Express, CORS, Dotenv.

---

## 🚀 Getting Started

### 1. Setup Environment
Create a `.env` in the root folder with your local PC network IP address:
```env
EXPO_PUBLIC_API_URL=http://<YOUR_LOCAL_IP>:5000
```

Configure credentials inside `server/.env`:
```env
PORT=5000
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
```

### 2. Install & Launch Backend
```bash
cd server
npm install
node index.js
```

### 3. Launch Expo Mobile App
From the root workspace folder:
```bash
npm install
npx expo start --web
```
Scan the QR code with **Expo Go** on Android/iOS to test natively, or press **w** to run on web.

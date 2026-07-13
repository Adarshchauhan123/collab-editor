import { io } from "socket.io-client";

// Where the backend server lives.
//
// Locally this defaults to the Express server we start with `npm start` in
// /server (port 4000). For a deployed build, set VITE_SERVER_URL (in
// client/.env, or as an env var in your Vercel project settings) to the
// deployed backend's URL, e.g. https://your-app.onrender.com — Vite bakes
// this in at BUILD time, so it must be set before you run `npm run build`.
export const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:4000";

// One shared socket connection for the whole app.
export const socket = io(SERVER_URL);

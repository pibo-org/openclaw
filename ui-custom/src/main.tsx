import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { App } from "./app.tsx";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Root element #root was not found.");
}

const app = <App />;

ReactDOM.createRoot(root).render(
  import.meta.env.DEV ? app : <React.StrictMode>{app}</React.StrictMode>,
);

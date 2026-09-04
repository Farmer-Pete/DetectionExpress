import "driver.js/dist/driver.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import "./index.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Root element #root not found");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

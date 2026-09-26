import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { SessionProvider } from "./hooks/session";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

createRoot(container).render(
  <StrictMode>
    <SessionProvider>
      <App />
    </SessionProvider>
  </StrictMode>,
);

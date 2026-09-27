import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { TooltipProvider } from "./components/ui/tooltip";
import { SessionProvider } from "./hooks/session";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

createRoot(container).render(
  <StrictMode>
    <SessionProvider>
      <TooltipProvider>
        <div className="min-h-dvh w-full antialiased">
          <App />
        </div>
      </TooltipProvider>
    </SessionProvider>
  </StrictMode>,
);

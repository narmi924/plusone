import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { LivePage } from "./live/LivePage";
import { SellerPage } from "./seller/SellerPage";
import "./index.css";

// AG Studio is large; the report loads only when the seller opens it.
const ReportPage = lazy(() => import("./report/ReportPage"));

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Navigate to="/live/lumicloset" replace />} />
        <Route path="/live/:handle" element={<LivePage />} />
        <Route path="/seller" element={<SellerPage />} />
        <Route
          path="/seller/report"
          element={
            <Suspense fallback={<p className="p-8 text-quiet">Opening the report…</p>}>
              <ReportPage />
            </Suspense>
          }
        />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);

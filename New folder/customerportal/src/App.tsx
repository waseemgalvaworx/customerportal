
import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { ThemeProvider } from "@/components/theme-provider";
import { AppProvider } from "@/contexts/AppContext";
import { PasswordAuthProvider } from "@/contexts/PasswordAuthContext";
import { RealtimeProvider } from "@/contexts/RealtimeContext";
import Index from "./pages/Index";
import NotFound from "./pages/NotFound";
import AdminCustomerMerge from "./pages/AdminCustomerMerge";
import VersionBadge from "@/components/VersionBadge";


const queryClient = new QueryClient();

// Providers are hoisted up to App so every route — including the admin
// tools at /admin/* — gets the same auth + realtime context. Previously
// they lived inside <Index> which meant only the customer portal saw
// them.
//
// New service-worker versions now activate automatically: the SW calls
// `self.skipWaiting()` on install and `clients.claim()` on activate, and
// the inline script in index.html listens for `controllerchange` and
// reloads the page exactly once. No user-facing "Reload" prompt needed.
const App = () => (
  <ThemeProvider defaultTheme="light">
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <VersionBadge />

        <BrowserRouter>
          <AppProvider>
            <PasswordAuthProvider>
              <RealtimeProvider>
                <Routes>
                  <Route path="/" element={<Index />} />
                  <Route
                    path="/admin/customer-merge"
                    element={<AdminCustomerMerge />}
                  />
                  <Route path="*" element={<NotFound />} />
                </Routes>
              </RealtimeProvider>
            </PasswordAuthProvider>
          </AppProvider>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  </ThemeProvider>
);

export default App;

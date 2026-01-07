import { useState, useEffect, lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation, useSearchParams } from "react-router-dom";
import { ThemeProvider } from 'next-themes';
import { Inspector, InspectParams } from 'react-dev-inspector';
import { HeroUIProvider } from '@heroui/react';
import './styles/github-markdown.css';
import 'react-photo-view/dist/react-photo-view.css';
import '@/lib/i18n';
import { initStore } from '@/store/init';
import { CommonLayout } from '@/components/Layout';
import { AppProvider } from '@/store/module/AppProvider';
import { BlinkoMultiSelectPop } from '@/components/BlinkoMultiSelectPop';
import { BlinkoMusicPlayer } from '@/components/BlinkoMusicPlayer';
import { LoadingPage } from '@/components/Common/LoadingPage';
import { PluginManagerStore } from '@/store/plugin/pluginManagerStore';
import { RootStore } from '@/store';
import { UserStore } from '@/store/user';
import { getTokenData, setNavigate } from '@/components/Auth/auth-client';
import { BlinkoStore } from '@/store/blinkoStore';
import { useAndroidShortcuts } from '@/lib/hooks';
import { useQuickaiHotkey } from '@/hooks/useQuickaiHotkey';
import { useInitialHotkeySetup } from '@/hooks/useInitialHotkeySetup';
import { isInTauri, isDesktop } from "@/lib/tauriHelper";
import { listen } from "@tauri-apps/api/event";
import QuickNotePage from "./pages/quicknote";
import QuickAIPage from "./pages/quickai";
import QuickToolPage from "./pages/quicktool";
import { useQuicknoteHotkey } from "./hooks/useQuicknoteHotkey";
import { useSseConnection } from '@/lib/useSseConnection';

const HomePage = lazy(() => import('./pages/index'));
const SignInPage = lazy(() => import('./pages/signin'));
const SignUpPage = lazy(() => import('./pages/signup'));
const HubPage = lazy(() => import('./pages/hub'));
const AIPage = lazy(() => import('./pages/ai'));
const ResourcesPage = lazy(() => import('./pages/resources'));
const ReviewPage = lazy(() => import('./pages/review'));
const SettingsPage = lazy(() => import('./pages/settings'));
const PluginPage = lazy(() => import('./pages/plugin'));
const AnalyticsPage = lazy(() => import('./pages/analytics'));
const AllPage = lazy(() => import('./pages/all'));
const OAuthCallbackPage = lazy(() => import('./pages/oauth-callback'));
const DetailPage = lazy(() => import('./pages/detail'));
const ShareIndexPage = lazy(() => import('./pages/share'));
const ShareDetailPage = lazy(() => import('./pages/share/[id]'));
const AiSharePage = lazy(() => import('./pages/ai-share'));

const HomeRedirect = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const blinko = RootStore.Get(BlinkoStore);
  const [searchParams] = useSearchParams();
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    const redirectToDefaultPage = async () => {
      await blinko.config.call();
      const defaultHomePage = blinko.config.value?.defaultHomePage;
      const currentPath = searchParams.get('path');
      const isDirectNavigation = location.key === 'default';
      if (currentPath || !defaultHomePage || defaultHomePage === 'blinko' || !isDirectNavigation) {
        setLoading(false);
        return;
      }
      
      navigate(`/?path=${defaultHomePage}`, { replace: true });
    };
    
    redirectToDefaultPage();
  }, [navigate, searchParams, location]);
  
  if (loading) {
    return <LoadingPage />;
  }
  
  return <HomePage />;
};

const ProtectedRoute = ({ children }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const [isChecking, setIsChecking] = useState(true);
  const userStore = RootStore.Get(UserStore);

  useEffect(() => {
    setNavigate(navigate);
  }, [navigate]);

  useEffect(() => {
    const checkAuth = async () => {
      const publicRoutes = ['/signin', '/signup', '/share', '/_offline', '/oauth-callback', '/ai-share', '/oauth-callback'];
      const isPublicRoute = publicRoutes.some(route =>
        location.pathname === route || location.pathname.startsWith('/share/') || location.pathname.startsWith('/ai-share/')
      );
      if (!userStore.isLogin && !isPublicRoute) {
        const tokenData = await getTokenData();
        console.log('tokenData', tokenData);

        if (!tokenData?.user?.id) {
          console.log('No valid token, redirecting to login page');
          navigate('/signin', { replace: true });
        }
      }

      setIsChecking(false);
    };

    checkAuth();
  }, [userStore.isLogin]);

  if (isChecking) {
    return <LoadingPage />;
  }

  return children;
};

// Detect current window type
const getWindowType = () => {
  if (!isInTauri()) return 'main';

  // Check URL path to determine window type
  const path = window.location.pathname;
  if (path.startsWith('/quicktool')) return 'quicktool';
  if (path.startsWith('/quicknote')) return 'quicknote';
  if (path.startsWith('/quickai')) return 'quickai';
  return 'main';
};

function AppRoutes() {
  const navigate = useNavigate();
  const windowType = getWindowType();

  // Initialize Quick AI hotkey handler inside Router context (only for main window on desktop)
  if (windowType === 'main' && isDesktop()) {
    useQuickaiHotkey();
    useQuicknoteHotkey(true);
  }

  // Listen for navigation commands from Tauri (only for current window type)
  useEffect(() => {
    if (!isInTauri()) return;

    let isMounted = true;
    let unlistenNavigation: (() => void) | null = null;

    const setupListener = async () => {
      try {
        if (!isMounted) return;

        unlistenNavigation = await listen('navigate-to-route', (event) => {
          const { route, replace = false, targetWindow } = event.payload as {
            route: string;
            replace?: boolean;
            targetWindow?: string;
          };

          // Only handle navigation for current window type or if no target specified
          if (!targetWindow || targetWindow === windowType) {
            console.log(`🔄 [${windowType}] Received navigation command:`, route, 'replace:', replace);

            if (replace) {
              navigate(route, { replace: true });
            } else {
              navigate(route);
            }

            // Emit event to notify components to refresh configuration
            if (windowType === 'quicktool') {
              console.log("🔄 Emitting config refresh event for quicktool");
              // This will be picked up by quicktool component to refresh its config
              window.dispatchEvent(new CustomEvent('quicktool-config-refresh'));
            }
          }
        });
      } catch (error) {
        console.error('Failed to setup navigation listener:', error);
      }
    };

    setupListener();

    return () => {
      isMounted = false;

      // Only try to unlisten if we have a valid function
      try {
        if (unlistenNavigation && typeof unlistenNavigation === 'function') {
          unlistenNavigation();
        }
      } catch (error) {
        console.error('Error cleaning up navigation listener:', error);
      }
    };
  }, [navigate, windowType]);

  // Return different routes based on window type
  switch (windowType) {
    case 'quicktool':
      return (
        <Suspense fallback={<LoadingPage />}>
          <Routes>
            <Route path="/quicktool" element={<QuickToolPage />} />
            <Route path="*" element={<Navigate to="/quicktool" replace />} />
          </Routes>
        </Suspense>
      );

    case 'quicknote':
      return (
        <Suspense fallback={<LoadingPage />}>
          <Routes>
            <Route path="/quicknote" element={<QuickNotePage />} />
            <Route path="*" element={<Navigate to="/quicknote" replace />} />
          </Routes>
        </Suspense>
      );

    case 'quickai':
      return (
        <Suspense fallback={<LoadingPage />}>
          <Routes>
            <Route path="/quickai" element={<QuickAIPage />} />
            <Route path="*" element={<Navigate to="/quickai" replace />} />
          </Routes>
        </Suspense>
      );

    default: // main window
      return (
        <Suspense fallback={<LoadingPage />}>
          <Routes>
            <Route path="/" element={<ProtectedRoute><HomeRedirect /></ProtectedRoute>} />
            <Route path="/signin" element={<SignInPage />} />
            <Route path="/signup" element={<SignUpPage />} />
            <Route path="/hub" element={<ProtectedRoute><HubPage /></ProtectedRoute>} />
            <Route path="/ai" element={<ProtectedRoute><AIPage /></ProtectedRoute>} />
            <Route path="/resources" element={<ProtectedRoute><ResourcesPage /></ProtectedRoute>} />
            <Route path="/review" element={<ProtectedRoute><ReviewPage /></ProtectedRoute>} />
            <Route path="/settings" element={<ProtectedRoute><SettingsPage /></ProtectedRoute>} />
            <Route path="/plugin" element={<ProtectedRoute><PluginPage /></ProtectedRoute>} />
            <Route path="/analytics" element={<ProtectedRoute><AnalyticsPage /></ProtectedRoute>} />
            <Route path="/all" element={<ProtectedRoute><AllPage /></ProtectedRoute>} />
            <Route path="/oauth-callback" element={<OAuthCallbackPage />} />
            <Route path="/detail/*" element={<ProtectedRoute><DetailPage /></ProtectedRoute>} />
            <Route path="/share" element={<ShareIndexPage />} />
            <Route path="/share/:id" element={<ShareDetailPage />} />
            <Route path="/ai-share/:id" element={<AiSharePage />} />
            <Route path="/quicknote" element={<QuickNotePage />} />
            <Route path="/quickai" element={<QuickAIPage />} />
            <Route path="/quicktool" element={<QuickToolPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      );
  }
}

function App() {
  initStore();

  // Establish SSE connection
  useSseConnection();

  // Initialize Android shortcuts handler
  useAndroidShortcuts();

  // Initialize hotkey setup for desktop app only
  if (isDesktop()) {
    useInitialHotkeySetup();
  }

  useEffect(() => {
    RootStore.Get(PluginManagerStore).initInstalledPlugins();
  }, []);

  return (
    <>
      <Inspector
        keys={['control', 'alt', 'x']}
        onClickElement={({ codeInfo }: InspectParams) => {
          if (!codeInfo?.absolutePath) return
          const { absolutePath, lineNumber, columnNumber } = codeInfo
          window.open(`cursor://file/${absolutePath}:${lineNumber}:${columnNumber}`)
        }}
      />
      <BrowserRouter>
        <HeroUIProvider>
          <ThemeProvider attribute="class" enableSystem={false}>
            <AppProvider />
            <CommonLayout>
              <div className="app-content">
                <AppRoutes />
                <BlinkoMultiSelectPop />
              </div>
            </CommonLayout>
          </ThemeProvider>
        </HeroUIProvider>
        <BlinkoMusicPlayer />
      </BrowserRouter>
    </>
  );
}

export default App;

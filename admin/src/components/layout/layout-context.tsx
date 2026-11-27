import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

type LayoutContextValue = {
  sidebarCollapse: boolean;
  setSidebarCollapse: (collapse: boolean) => void;
  sidebarDark: boolean;
  setSidebarDark: (dark: boolean) => void;
  commandOpen: boolean;
  setCommandOpen: (open: boolean) => void;
  uploadSheetOpen: boolean;
  setUploadSheetOpen: (open: boolean) => void;
};

const LayoutContext = createContext<LayoutContextValue | null>(null);

const COLLAPSE_KEY = 'piccove.sidebar.collapse';
const DARK_SIDEBAR_KEY = 'piccove.sidebar.dark';

export function LayoutProvider({ children }: { children: ReactNode }) {
  const [sidebarCollapse, setSidebarCollapseState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [sidebarDark, setSidebarDarkState] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DARK_SIDEBAR_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [commandOpen, setCommandOpen] = useState(false);
  const [uploadSheetOpen, setUploadSheetOpen] = useState(false);

  const setSidebarCollapse = (value: boolean) => {
    setSidebarCollapseState(value);
    try {
      localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0');
    } catch {
      // Storage unavailable; keep session state.
    }
  };

  const setSidebarDark = (value: boolean) => {
    setSidebarDarkState(value);
    try {
      localStorage.setItem(DARK_SIDEBAR_KEY, value ? '1' : '0');
    } catch {
      // Storage unavailable; keep session state.
    }
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <LayoutContext.Provider
      value={{
        sidebarCollapse,
        setSidebarCollapse,
        sidebarDark,
        setSidebarDark,
        commandOpen,
        setCommandOpen,
        uploadSheetOpen,
        setUploadSheetOpen,
      }}
    >
      {children}
    </LayoutContext.Provider>
  );
}

export function useLayout() {
  const context = useContext(LayoutContext);
  if (!context) {
    throw new Error('useLayout must be used within a LayoutProvider');
  }
  return context;
}

import React, {
  ReactNode,
  createContext,
  useContext,
  useEffect,
  useState,
} from "react";
// authContext.ts
import { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabaseClient";

// Define a unified AuthResponse type
interface AuthResponse {
  success: boolean;
  data?: {
    user: User | null;
    session: Session | null;
  };
  error?: string;
}

interface AuthContextType {
  session: any | null;
  signUpNewUser: (email: string, password: string) => Promise<any>;
  signInUser: (email: string, password: string) => Promise<any>;
  signInWithGoogle: () => Promise<any>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  session: null,
  signUpNewUser: async () => ({ data: { user: {}, session: {} }, error: null }),
  signInUser: async () => ({ data: { user: {}, session: {} }, error: null }),
  signInWithGoogle: async () => ({ data: { user: {}, session: {} }, error: null }),
  signOut: async () => {},
});

// AuthProvider.tsx
interface AuthContextProviderProps {
  children: ReactNode;
}

export const AuthContextProvider: React.FC<AuthContextProviderProps> = ({
  children,
}) => {
  const [session, setSession] = useState<Session | null>(null);

  // Temporarily provide mock auth functions
  const mockAuthResponse = { data: { user: {}, session: {} }, error: null };

  // Sign Up
  const signUpNewUser = async (
    email: string,
    password: string
  ): Promise<AuthResponse> => {
    try {
      const { data, error } = await supabase.auth.signUp({
        email: email.toLowerCase(),
        password: password,
      });

      if (error) {
        return {
          success: false,
          error: error.message,
        };
      }

      return {
        success: true,
        data: {
          user: data.user,
          session: data.session,
        },
      };
    } catch (err) {
      const error = err as Error;
      return {
        success: false,
        error: error.message,
      };
    }
  };

  // Sign In
  const signInUser = async (
    email: string,
    password: string
  ): Promise<AuthResponse> => {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.toLowerCase(),
        password: password,
      });

      if (error) {
        return {
          success: false,
          error: error.message,
        };
      }

      return {
        success: true,
        data: {
          user: data.user,
          session: data.session,
        },
      };
    } catch (err) {
      const error = err as Error;
      console.error("Unexpected error during sign-in:", error.message); // Debugging
      return {
        success: false,
        error: "An unexpected error occurred. Please try again.",
      };
    }
  };

  const signInWithGoogle = async (): Promise<AuthResponse> => {
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
      });

      if (error) {
        return {
          success: false,
          error: error.message,
        };
      }

      return {
        success: true,
        data: {
          user: session?.user ?? null,
          session: session ?? null,
        },
      };
    } catch (err) {
      const error = err as Error;
      return {
        success: false,
        error: error.message,
      };
    }
  };

  // Sign Out
  const signOut = async (): Promise<void> => {
    const { error } = await supabase.auth.signOut();
    if (error) {
      throw error;
    }
  };

  // Subscribe to session changes
  useEffect(() => {
    let subscription: { unsubscribe: () => void } | null = null;

    const getInitialSession = async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      setSession(session);

      const {
        data: { subscription: authSub },
      } = supabase.auth.onAuthStateChange((_event, session) => {
        setSession(session);
      });

      subscription = authSub;
    };

    getInitialSession();

    return () => {
      if (subscription) {
        subscription.unsubscribe();
      }
    };
  }, []);

  const value: AuthContextType = {
    session: null,
    signUpNewUser: async () => mockAuthResponse,
    signInUser: async () => mockAuthResponse,
    signInWithGoogle: async () => mockAuthResponse,
    signOut: async () => {},
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

// useAuth.ts
// eslint-disable-next-line react-refresh/only-export-components
export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthContextProvider");
  }
  return context;
};

import "react-toastify/dist/ReactToastify.css";

import React, { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "react-toastify";
import { useAuth } from "@/Context/AuthContext";
import { useNavigate } from "react-router-dom";

const AuthForm: React.FC = () => {
  const [isSignUp, setIsSignUp] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const { signUpNewUser, signInUser, signInWithGoogle, session } = useAuth();
  console.log("session :", session);
  const navigate = useNavigate();

  // Reusable navigation and toast logic
  const handleNavigation = (message: string) => {
    toast.success(message); // Show toast message
    navigate("/notes"); // Redirect to /notes
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMessage(null); // Clear any previous error messages

    try {
      if (isSignUp) {
        const { data, error } = await signUpNewUser(email, password);

        if (data?.user && data?.session) {
          // Sign-up successful
          handleNavigation("Sign up successful!");
        } else {
          // Display the error message
          setErrorMessage(error ?? "An unknown error occurred.");
        }
      } else {
        const { data, error } = await signInUser(email, password);

        if (data?.user && data?.session) {
          // Sign-in successful
          handleNavigation("Sign in successful!");
        } else {
          // Display the error message
          setErrorMessage(error ?? "An unknown error occurred.");
        }
      }
    } finally {
      setLoading(false);
    }
  };
  const handleGoogleSignIn = async () => {
    setLoading(true);
    setErrorMessage(null);

    try {
      await signInWithGoogle();

      if (session) {
        navigate("/notes");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="w-full h-full bg-neutral-900 flex items-center justify-center p-8">
      <div
        className={`w-full max-w-md transition-transform duration-300 ${
          isSignUp ? "translate-y-0" : "-translate-y-4"
        }`}
      >
        <h2 className="text-2xl font-bold text-white text-center">
          {isSignUp ? "Get started" : "Welcome back"}
        </h2>
        <p className="text-sm text-neutral-400 text-center mt-2">
          {isSignUp ? "Create a new account" : "Sign in to your account"}
        </p>

        {errorMessage && (
          <p className="text-red-500 text-center mt-4">{errorMessage}</p>
        )}
        <Button
          type="button"
          onClick={handleGoogleSignIn}
          disabled={loading}
          className="w-full bg-white my-6 hover:bg-gray-100 text-black flex items-center justify-center gap-2"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24">
            <path
              fill="currentColor"
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
            />
            <path
              fill="currentColor"
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            />
            <path
              fill="currentColor"
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            />
            <path
              fill="currentColor"
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            />
          </svg>
          Continue with Google
        </Button>
        <form onSubmit={handleSubmit} className="space-y-6">
          <div>
            <label
              htmlFor="email"
              className="block text-sm font-medium text-neutral-400"
            >
              Email
            </label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              className="mt-1 bg-neutral-800 border-neutral-700 py-6 text-white"
            />
          </div>
          <div>
            <label
              htmlFor="password"
              className="block text-sm font-medium text-neutral-400"
            >
              Password
            </label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              required
              className="mt-1 bg-neutral-800 border-neutral-700 py-6 text-white"
            />
          </div>
          <Button
            type="submit"
            disabled={loading || !email || !password}
            className="w-full bg-green-600 hover:bg-green-500 disabled:bg-gray-700"
          >
            {loading ? "Processing..." : isSignUp ? "Sign Up" : "Sign In"}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-neutral-400">
          {isSignUp ? "Have an account?" : "Don't have an account?"}{" "}
          <button
            type="button"
            onClick={() => setIsSignUp(!isSignUp)}
            className="text-green-500 hover:text-green-400 font-medium"
          >
            {isSignUp ? "Sign In Now" : "Sign Up Now"}
          </button>
        </p>
      </div>
    </div>
  );
};

export default AuthForm;

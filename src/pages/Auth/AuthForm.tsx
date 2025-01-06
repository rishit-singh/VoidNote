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

  const { signUpNewUser, signInUser } = useAuth();
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

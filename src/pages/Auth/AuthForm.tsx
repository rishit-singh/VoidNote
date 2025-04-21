import React from "react";
import { Button } from "@/components/ui/button";

const AuthForm: React.FC = () => {
  return (
    <div className="flex justify-center items-center h-screen bg-gray-900">
      <div className="w-full max-w-md p-8 space-y-6 bg-gray-800 rounded-lg shadow-lg">
        <h2 className="text-2xl font-bold text-center text-white">
          Authentication Disabled
        </h2>
        <p className="text-center text-gray-400">
          Authentication is temporarily disabled for development.
        </p>
        <Button
          className="w-full"
          onClick={() => window.location.href = '/notes'}
        >
          Go to Notes
        </Button>
      </div>
    </div>
  );
};

export default AuthForm;

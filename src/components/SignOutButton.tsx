import { Button } from "./ui/button";
import { LogOut } from "lucide-react";
import { toast } from "react-toastify";
import { useAuth } from "@/Context/AuthContext";
import { useNavigate } from "react-router-dom";

const SignOutButton = () => {
  const { signOut } = useAuth(); // Use context's signOut
  const navigate = useNavigate();

  const handleSignOut = async () => {
    try {
      await signOut(); // Call the context's signOut function
      toast.success("Sign out successful!"); // Show toast notification
      navigate("/"); // Redirect to home or login page
    } catch (err) {
      toast.error("Error during sign-out. Please try again."); // Show error toast
      console.error("Error during sign-out:", err);
    }
  };

  return (
    <div className="mt-auto p-6">
      <Button
        variant="ghost"
        size="lg"
        className="w-full flex items-center justify-start text-white hover:bg-gray-700"
        onClick={handleSignOut}
      >
        <LogOut className="mr-2 h-5 w-5" />
        Sign Out
      </Button>
    </div>
  );
};

export default SignOutButton;

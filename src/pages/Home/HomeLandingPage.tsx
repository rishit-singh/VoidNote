import AuthForm from "../Auth/AuthForm";
import LandingContent from "./LandingContent";

const HomeLandingPage: React.FC = () => {
  return (
    <div className="flex flex-col lg:flex-row min-h-screen bg-black">
      {/* Landing Content: Full-width on small screens, half-width on large screens */}
      <div className="w-full lg:w-1/2">
        <LandingContent />
      </div>

      {/* Auth Form: Full-width on small screens, half-width on large screens */}
      <div className="w-full lg:w-1/2">
        <AuthForm />
      </div>
    </div>
  );
};

export default HomeLandingPage;

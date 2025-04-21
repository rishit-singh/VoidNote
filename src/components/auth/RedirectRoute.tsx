import React from 'react';
import { Navigate } from 'react-router-dom';

interface RedirectRouteProps {
  children: React.ReactNode;
}

const RedirectRoute: React.FC<RedirectRouteProps> = ({ children }) => {
  // Temporarily disable redirect - always show landing page
  return <>{children}</>;
};

export default RedirectRoute;

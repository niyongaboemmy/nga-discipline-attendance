import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth, homeRouteForRole } from '../../context/AuthContext';
import type { Role } from '../../context/AuthContext';
import { LoadingSpinner } from './LoadingSpinner';

interface ProtectedRouteProps {
  children: React.ReactElement;
  allowedRoles?: Role[];
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children, allowedRoles }) => {
  const { isAuthenticated, user, loading } = useAuth();

  // Role is read from context (restored from storage), so this re-validates on refresh too.
  if (loading) return <LoadingSpinner fullPage />;
  if (!isAuthenticated || !user) return <Navigate to="/" replace />;

  if (allowedRoles) {
    // Wrong role for this route → send the user to their own home.
    if (!allowedRoles.includes(user.role)) {
      return <Navigate to={homeRouteForRole(user.role)} replace />;
    }
  } else if (user.role === 'unassigned') {
    // Open routes still aren't available to users without an assigned role.
    return <Navigate to="/pending" replace />;
  }

  return children;
};

import React, { useEffect, useState } from 'react';
import { usePasswordAuth } from '@/contexts/PasswordAuthContext';
import LoginForm from '@/components/portal/LoginForm';
import CustomerPortal from '@/components/portal/CustomerPortal';
import { Loader2, ShieldAlert } from 'lucide-react';

const AppLayout: React.FC = () => {
  const { user, loading, logout } = usePasswordAuth();
  const [denied, setDenied] = useState(false);

  // Replicate original customer portal access check:
  // Access is granted ONLY if:
  //   1. role === 'customer_portal', OR
  //   2. permissions.allowedScreens contains 'customer-portal' AND it's the ONLY allowed screen
  const allowedScreens = user?.permissions?.allowedScreens;
  const isCustomerPortalUser = !!user && (
    user.role === 'customer_portal' ||
    (Array.isArray(allowedScreens) &&
      allowedScreens.includes('customer-portal') &&
      allowedScreens.length === 1)
  );

  // If a non-portal user authenticated, immediately sign them out and
  // bounce back to the login screen. Show a brief "Access Denied" flash
  // while the logout completes.
  useEffect(() => {
    if (!loading && user && !isCustomerPortalUser) {
      setDenied(true);
      const t = setTimeout(() => {
        logout();
        setDenied(false);
      }, 1200);
      return () => clearTimeout(t);
    }
  }, [loading, user, isCustomerPortalUser, logout]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="flex items-center gap-2 text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span>Loading…</span>
        </div>
      </div>
    );
  }

  if (denied) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
        <div className="flex items-center gap-2 text-red-600 font-semibold">
          <ShieldAlert className="w-5 h-5" />
          <span>Access Denied</span>
        </div>
      </div>
    );
  }

  if (!user || !isCustomerPortalUser) {
    return <LoginForm />;
  }

  return <CustomerPortal />;
};

export default AppLayout;

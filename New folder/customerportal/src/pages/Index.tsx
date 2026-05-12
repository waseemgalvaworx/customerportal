import React from 'react';
import AppLayout from '@/components/AppLayout';

// Providers (AppProvider, PasswordAuthProvider, RealtimeProvider) used to
// live here, but they're now hoisted up to App.tsx so every route shares
// a single provider tree. Index just renders the customer-portal shell.
const Index: React.FC = () => {
  return <AppLayout />;
};

export default Index;

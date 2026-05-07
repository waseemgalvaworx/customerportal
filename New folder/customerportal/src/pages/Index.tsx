import React from 'react';
import AppLayout from '@/components/AppLayout';
import { AppProvider } from '@/contexts/AppContext';
import { PasswordAuthProvider } from '@/contexts/PasswordAuthContext';
import { RealtimeProvider } from '@/contexts/RealtimeContext';

const Index: React.FC = () => {
  return (
    <AppProvider>
      <PasswordAuthProvider>
        <RealtimeProvider>
          <AppLayout />
        </RealtimeProvider>
      </PasswordAuthProvider>
    </AppProvider>
  );
};

export default Index;

import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import type { RealtimeChannel } from '@supabase/supabase-js';

type ConnState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';

type Listener = (payload: any) => void;

interface RealtimeContextValue {
  state: ConnState;
  subscribe: (table: 'jobs' | 'quality_control' | 'item_stage_tracking', listener: Listener) => () => void;
  reconnect: () => void;
}

const RealtimeContext = createContext<RealtimeContextValue | undefined>(undefined);

export const RealtimeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<ConnState>('idle');
  const channelsRef = useRef<Record<string, RealtimeChannel>>({});
  const listenersRef = useRef<Record<string, Set<Listener>>>({
    jobs: new Set(),
    quality_control: new Set(),
    item_stage_tracking: new Set(),
  });
  const backoffRef = useRef(1000);
  // Unique instance id so channel topic names never collide with stale
  // channels left over in the supabase client (e.g. React StrictMode double
  // mount). Reusing a topic name causes supabase.channel() to return the
  // already-subscribed channel, and calling .on() on it throws:
  //   "cannot add `postgres_changes` callbacks ... after `subscribe()`"
  const instanceIdRef = useRef<string>(
    `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  );

  const setupChannel = useCallback((table: keyof typeof listenersRef.current) => {
    if (channelsRef.current[table]) return;
    setState('connecting');

    const topic = `portal_${table}_${instanceIdRef.current}`;

    // Defensive: if a channel with this exact topic somehow already exists
    // in the supabase client, remove it before creating a new one so we
    // never call .on() on an already-subscribed channel.
    try {
      const existing = supabase
        .getChannels()
        .filter((c) => c.topic === `realtime:${topic}`);
      existing.forEach((c) => {
        try { supabase.removeChannel(c); } catch {}
      });
    } catch {}

    const channel = supabase.channel(topic);

    // CRITICAL: register .on() BEFORE .subscribe(). Never call .on() after
    // .subscribe() — supabase realtime forbids it.
    channel.on(
      'postgres_changes',
      { event: '*', schema: 'public', table },
      (payload) => {
        listenersRef.current[table].forEach((l) => {
          try { l(payload); } catch (e) { console.warn(e); }
        });
      }
    );

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        setState('connected');
        backoffRef.current = 1000;
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        setState('reconnecting');
        // Exponential backoff reconnect — fully tear down and recreate the
        // channel so .on() is registered fresh before .subscribe().
        const delay = Math.min(backoffRef.current, 30000);
        backoffRef.current = Math.min(backoffRef.current * 2, 30000);
        setTimeout(() => {
          try { supabase.removeChannel(channel); } catch {}
          delete channelsRef.current[table];
          if (listenersRef.current[table].size > 0) {
            setupChannel(table);
          }
        }, delay);
      }
    });

    channelsRef.current[table] = channel;
  }, []);

  const subscribe: RealtimeContextValue['subscribe'] = useCallback((table, listener) => {
    listenersRef.current[table].add(listener);
    // Listeners are stored in a Set and dispatched from the single
    // postgres_changes callback registered at channel creation. Adding more
    // listeners here does NOT call .on() again, so it's safe after subscribe.
    setupChannel(table);
    return () => {
      listenersRef.current[table].delete(listener);
    };
  }, [setupChannel]);

  const reconnect = useCallback(() => {
    Object.entries(channelsRef.current).forEach(([key, ch]) => {
      try { supabase.removeChannel(ch); } catch {}
      delete channelsRef.current[key];
    });
    backoffRef.current = 1000;
    (Object.keys(listenersRef.current) as Array<keyof typeof listenersRef.current>).forEach((t) => {
      if (listenersRef.current[t].size > 0) setupChannel(t);
    });
  }, [setupChannel]);

  useEffect(() => {
    return () => {
      Object.values(channelsRef.current).forEach((ch) => {
        try { supabase.removeChannel(ch); } catch {}
      });
      channelsRef.current = {};
    };
  }, []);

  return (
    <RealtimeContext.Provider value={{ state, subscribe, reconnect }}>
      {children}
    </RealtimeContext.Provider>
  );
};


export const useRealtime = () => {
  const ctx = useContext(RealtimeContext);
  if (!ctx) throw new Error('useRealtime must be used within RealtimeProvider');
  return ctx;
};

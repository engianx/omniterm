import React from 'react';
import { Session } from './Session';

/**
 * Conversation-per-tab: the whole SPA IS one conversation (the one served at
 * `/agent/<id>/`). No in-iframe routing or session list — omniterm's tab bar is
 * the conversation list. The id lives in the page prefix; the Session component
 * talks to the backend with relative URLs, so it never needs the id explicitly.
 */
export function App() {
  return <Session />;
}

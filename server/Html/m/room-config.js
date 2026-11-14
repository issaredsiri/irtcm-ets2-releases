// Supabase project used as the shared room for the multi-player map (see PLAN.md, "ห้องกลาง").
// Fill in from Supabase dashboard -> Project Settings -> API. The anon key is meant to be public:
// it ends up in every visitor's browser anyway. tools/bridge.js reads this file too.
window.ROOM_CONFIG = {
  supabaseUrl: 'https://nllmtrjbltnvrriajmww.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5sbG10cmpibHRudnJyaWFqbXd3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ2NTM3NDksImV4cCI6MjExMDIyOTc0OX0.bH1glbk1-Yv_oMDr1EGucFnl-YNYHEqgfZ0_udQzdiw'   // the "anon public" key
};

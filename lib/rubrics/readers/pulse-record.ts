// GUARD: moved to lib/room-access/ (the only module that runs SQL on room data). This path re-exports it so existing imports keep working.
export * from "@/lib/room-access/readers/pulse-record";

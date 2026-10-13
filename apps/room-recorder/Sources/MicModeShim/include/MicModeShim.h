#ifndef MICMODESHIM_H
#define MICMODESHIM_H

#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/// Test hook: re-resolve against another library path (NULL restores the system default).
void rr_micmode_reset_resolver(const char *framework_path);
/// 1 when AVFCapture loaded and all four mic-mode symbols resolved, else 0. Never throws.
int rr_micmode_available(void);
/// Preferred mode for the bundle id (0 Standard, 1 Wide Spectrum, 2 Voice Isolation); -1 when unreadable.
long rr_micmode_get(const char *bundle);
/// Active mode for the bundle id; -1 when unreadable.
long rr_micmode_get_active(const char *bundle);
/// 1 when the supported list contains mode, 0 when it does not, -1 when the list is unreadable.
int rr_micmode_supported_contains(const char *bundle, long mode);
/// 1 ok, 0 refused, -1 exception or unavailable. Message (if any) is copied into err.
int rr_micmode_set(const char *bundle, long mode, char *err, size_t errlen);

#ifdef __cplusplus
}
#endif

#endif

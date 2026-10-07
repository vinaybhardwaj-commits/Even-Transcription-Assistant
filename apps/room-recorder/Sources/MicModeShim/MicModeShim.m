#import <Foundation/Foundation.h>
#include <dlfcn.h>
#include <string.h>
#include "MicModeShim.h"

typedef long (*RRGetFn)(NSString *);
typedef NSArray *(*RRSupportedFn)(NSString *);
typedef BOOL (*RRSetFn)(long, NSString *);

static RRGetFn gGet, gGetActive;
static RRSupportedFn gSupported;
static RRSetFn gSet;
static int gResolved;

static void rr_resolve(void) {
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    @try {
      const char *path = "/System/Library/PrivateFrameworks/AVFCapture.framework/AVFCapture";
      void *h = dlopen(path, RTLD_LAZY | RTLD_NOLOAD);
      if (!h) h = dlopen(path, RTLD_LAZY);
      if (!h) return;
      gGet = (RRGetFn)dlsym(h, "AVControlCenterMicrophoneModesModuleGetMicrophoneModeForBundleID");
      gGetActive = (RRGetFn)dlsym(h, "AVControlCenterMicrophoneModesModuleGetActiveMicrophoneModeForBundleID");
      gSupported = (RRSupportedFn)dlsym(h, "AVControlCenterMicrophoneModesModuleGetSupportedMicrophoneModesForBundleID");
      gSet = (RRSetFn)dlsym(h, "AVControlCenterMicrophoneModesModuleSetMicrophoneModeForBundleID");
      gResolved = (gGet && gGetActive && gSupported && gSet) ? 1 : 0;
    } @catch (NSException *e) {
      gResolved = 0;
    }
  });
}

static void rr_copy_err(char *err, size_t errlen, NSString *msg) {
  if (!err || errlen == 0) return;
  const char *s = msg ? [msg UTF8String] : "";
  strlcpy(err, s ? s : "", errlen);
}

int rr_micmode_available(void) {
  rr_resolve();
  return gResolved;
}

long rr_micmode_get(const char *bundle) {
  rr_resolve();
  if (!gResolved || !bundle) return -1;
  @try {
    return gGet([NSString stringWithUTF8String:bundle]);
  } @catch (NSException *e) {
    return -1;
  }
}

long rr_micmode_get_active(const char *bundle) {
  rr_resolve();
  if (!gResolved || !bundle) return -1;
  @try {
    return gGetActive([NSString stringWithUTF8String:bundle]);
  } @catch (NSException *e) {
    return -1;
  }
}

int rr_micmode_supported_contains(const char *bundle, long mode) {
  rr_resolve();
  if (!gResolved || !bundle) return -1;
  @try {
    NSArray *list = gSupported([NSString stringWithUTF8String:bundle]);
    if (![list isKindOfClass:[NSArray class]]) return -1;
    for (id item in list) {
      if ([item respondsToSelector:@selector(longValue)] && [item longValue] == mode) return 1;
    }
    return 0;
  } @catch (NSException *e) {
    return -1;
  }
}

int rr_micmode_set(const char *bundle, long mode, char *err, size_t errlen) {
  rr_copy_err(err, errlen, nil);
  rr_resolve();
  if (!gResolved || !bundle) return -1;
  @try {
    return gSet(mode, [NSString stringWithUTF8String:bundle]) ? 1 : 0;
  } @catch (NSException *e) {
    rr_copy_err(err, errlen, [e reason] ?: [e name]);
    return -1;
  }
}

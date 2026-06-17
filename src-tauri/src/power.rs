//! Keep heavy work running at full speed when the window isn't frontmost.
//!
//! When disk-solve loses focus (or is fully occluded), macOS App Nap throttles
//! the process: it coalesces our timers and drops the CPU priority of every
//! thread, so a scan or a duplicate hash slows to a crawl. Registering an
//! `NSProcessInfo` *activity* tells the OS this is user-initiated work that
//! should not be napped. App Nap is suppressed process-wide for as long as any
//! activity is held, so a single assertion on the walking thread also protects
//! the duplicate-hashing workers running alongside it.
//!
//! The assertion is held by an RAII guard ([`KeepAwake`]) and released the moment
//! the work ends, so we opt out of App Nap only while genuinely busy — not while
//! the app sits idle in the background, where App Nap's power savings are welcome.
//!
//! `UserInitiatedAllowingIdleSystemSleep` keeps full priority regardless of focus
//! but deliberately omits the "disable idle system sleep" bit: we suppress the
//! throttling, not the Mac's own power management, so the machine can still sleep
//! normally if the user walks away mid-scan.

use objc2::rc::Retained;
use objc2::runtime::{NSObjectProtocol, ProtocolObject};
use objc2_foundation::{NSActivityOptions, NSProcessInfo, NSString};

/// Holds an `NSProcessInfo` activity assertion. Dropping it ends the activity,
/// re-enabling App Nap.
pub struct KeepAwake {
    process_info: Retained<NSProcessInfo>,
    token: Retained<ProtocolObject<dyn NSObjectProtocol>>,
}

impl KeepAwake {
    /// Begin a user-initiated activity that suppresses App Nap (while still
    /// allowing the system to idle-sleep). `reason` is surfaced in power
    /// diagnostics (e.g. `pmset -g assertions`). The activity APIs are
    /// thread-safe, so this can be called from any worker thread.
    pub fn begin(reason: &str) -> Self {
        let process_info = NSProcessInfo::processInfo();
        let token = process_info.beginActivityWithOptions_reason(
            NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
            &NSString::from_str(reason),
        );
        KeepAwake { process_info, token }
    }
}

impl Drop for KeepAwake {
    fn drop(&mut self) {
        // SAFETY: `token` was produced by `beginActivityWithOptions:reason:` on
        // this same `NSProcessInfo`, so it is the correct object to end.
        unsafe { self.process_info.endActivity(&self.token) };
    }
}

use wrap::chrome::Notification;
use wrap::session::router::{NotificationRouter, Routed};

fn chrome(text: &str) -> Notification {
    Notification::Chrome {
        text: text.into(),
        icon: None,
    }
}

fn step_output(text: &str) -> Notification {
    Notification::StepOutput { text: text.into() }
}

#[test]
fn without_a_dialog_notifications_go_straight_to_stderr() {
    let mut router = NotificationRouter::new();
    assert_eq!(
        router.route(chrome("hello"), false),
        Routed::Stderr(chrome("hello"))
    );
    assert_eq!(
        router.route(chrome("live?"), true),
        Routed::Stderr(chrome("live?"))
    );
    assert!(!router.is_dialog_mounted());
}

#[test]
fn with_a_dialog_mounted_notifications_are_buffered_until_teardown() {
    let mut router = NotificationRouter::new();
    router.set_dialog_mounted();
    assert!(router.is_dialog_mounted());
    assert_eq!(router.route(chrome("first"), false), Routed::Buffered);
    assert_eq!(router.route(chrome("second"), false), Routed::Buffered);
    let flushed = router.teardown_dialog().expect("a dialog was mounted");
    assert_eq!(flushed, vec![chrome("first"), chrome("second")]);
    assert!(!router.is_dialog_mounted());
}

#[test]
fn a_live_dialog_also_receives_the_notification() {
    let mut router = NotificationRouter::new();
    router.set_dialog_mounted();
    assert_eq!(router.route(chrome("ignored"), false), Routed::Buffered);
    assert_eq!(
        router.route(chrome("chrome-live"), true),
        Routed::Live(chrome("chrome-live"))
    );
    assert_eq!(
        router.route(step_output("step-live"), true),
        Routed::Live(step_output("step-live"))
    );
    // Live notifications are still replayed on teardown.
    let flushed = router.teardown_dialog().unwrap();
    assert_eq!(
        flushed,
        vec![
            chrome("ignored"),
            chrome("chrome-live"),
            step_output("step-live")
        ]
    );
}

#[test]
fn teardown_is_idempotent_and_a_no_op_without_a_dialog() {
    let mut router = NotificationRouter::new();
    assert_eq!(router.teardown_dialog(), None);
    router.set_dialog_mounted();
    router.route(chrome("x"), false);
    assert!(router.teardown_dialog().is_some());
    assert_eq!(router.teardown_dialog(), None);
    // After teardown the next notification goes to stderr again.
    assert_eq!(
        router.route(chrome("after"), false),
        Routed::Stderr(chrome("after"))
    );
}

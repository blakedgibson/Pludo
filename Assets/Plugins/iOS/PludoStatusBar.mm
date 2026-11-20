#import <UIKit/UIKit.h>

// Static flag read by the UnityViewController category below.
static BOOL _pludoStatusBarHidden = NO;

// Override prefersStatusBarHidden on Unity's root view controller so the
// system respects our flag even with UIViewControllerBasedStatusBarAppearance=YES.
@interface UIViewController (PludoStatusBar)
@end

@implementation UIViewController (PludoStatusBar)
- (BOOL)prefersStatusBarHidden {
    return _pludoStatusBarHidden;
}
- (UIStatusBarStyle)preferredStatusBarStyle {
    return UIStatusBarStyleLightContent;
}
@end

static void UpdateStatusBar(BOOL hidden) {
    _pludoStatusBarHidden = hidden;
    dispatch_async(dispatch_get_main_queue(), ^{
        UIViewController *root = UIApplication.sharedApplication.keyWindow.rootViewController;
        [root setNeedsStatusBarAppearanceUpdate];
    });
}

extern "C" {
    void PludoStatusBar_Show() { UpdateStatusBar(NO); }
    void PludoStatusBar_Hide() { UpdateStatusBar(YES); }
}

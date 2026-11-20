#import <UIKit/UIKit.h>

// Pushes an orientation change through UIKit's window scene API (iOS 16+).
// Unity's Screen.orientation C# API alone is insufficient on iOS 16+ — the OS
// requires an explicit UIWindowScene.requestGeometryUpdate call to commit the change.
static void DoRequestOrientation(UIInterfaceOrientationMask mask) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (@available(iOS 16.0, *)) {
            for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
                if (![scene isKindOfClass:[UIWindowScene class]]) continue;
                UIWindowScene *ws = (UIWindowScene *)scene;
                UIWindowSceneGeometryPreferencesIOS *prefs =
                    [[UIWindowSceneGeometryPreferencesIOS alloc]
                     initWithInterfaceOrientations:mask];
                [ws requestGeometryUpdateWithPreferences:prefs
                                           errorHandler:^(NSError *e) {
                    NSLog(@"[PludoOrientation] requestGeometryUpdate: %@", e.localizedDescription);
                }];
                for (UIWindow *w in ws.windows) {
                    [w.rootViewController setNeedsUpdateOfSupportedInterfaceOrientations];
                }
            }
        }
    });
}

extern "C" {
    void PludoOrientation_ForceLandscape() {
        DoRequestOrientation(UIInterfaceOrientationMaskLandscape);
    }
    void PludoOrientation_ForcePortrait() {
        DoRequestOrientation(UIInterfaceOrientationMaskPortrait);
    }
}

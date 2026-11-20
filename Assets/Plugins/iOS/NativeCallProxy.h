// Unity-as-a-Library bridge to the React Native shell (native-shell/).
// The shell's RNUnityView registers itself here with
// [FrameworkLibAPI registerAPIforNativeCalls:self]; Unity then reaches it via
// the C functions in NativeCallProxy.mm. Must be a PUBLIC header of the
// UnityFramework target (NativeShellBuild sets that after export).
#import <Foundation/Foundation.h>

@protocol NativeCallsProtocol
@required

- (void) sendMessageToMobileApp:(NSString*)message;

@end

__attribute__ ((visibility("default")))
@interface FrameworkLibAPI : NSObject

+(void) registerAPIforNativeCalls:(id<NativeCallsProtocol>) aApi;

@end

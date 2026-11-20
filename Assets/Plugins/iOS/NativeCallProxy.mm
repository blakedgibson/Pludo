#import <Foundation/Foundation.h>
#import "NativeCallProxy.h"

@implementation FrameworkLibAPI

static id<NativeCallsProtocol> api = NULL;
+(void) registerAPIforNativeCalls:(id<NativeCallsProtocol>) aApi
{
    api = aApi;
}

@end

extern "C"
{
    // NativeShellBridge.cs → React Native shell. No-op when Unity runs as a
    // standalone app (no host registered).
    void sendMessageToMobileApp(const char* message)
    {
        if (api == NULL || message == NULL) return;
        [api sendMessageToMobileApp:[NSString stringWithUTF8String:message]];
    }

    // GameBridge.cs declares SendToApp for iOS but no iOS implementation
    // existed; route it to the same host channel.
    void SendToApp(const char* message)
    {
        sendMessageToMobileApp(message);
    }
}

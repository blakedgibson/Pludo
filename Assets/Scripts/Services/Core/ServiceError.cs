namespace Pludo.Services.Core
{
    public enum ServiceErrorCategory
    {
        Network,     // offline / timeout — retryable
        Auth,        // token expired / unauthorized — refresh then retry
        Validation,  // bad input / RLS denial — show to user
        Server,      // 5xx / service down — retry with backoff
        Domain,      // business rule violation — show specific message
    }

    public readonly struct ServiceError
    {
        public ServiceErrorCategory Category { get; }
        public string Message { get; }
        public int StatusCode { get; }

        public ServiceError(ServiceErrorCategory category, string message, int statusCode = 0)
        {
            Category = category;
            Message = message;
            StatusCode = statusCode;
        }

        public static ServiceError Network(string message, int statusCode = 0) =>
            new ServiceError(ServiceErrorCategory.Network, message, statusCode);
        public static ServiceError Auth(string message, int statusCode = 0) =>
            new ServiceError(ServiceErrorCategory.Auth, message, statusCode);
        public static ServiceError Validation(string message, int statusCode = 0) =>
            new ServiceError(ServiceErrorCategory.Validation, message, statusCode);
        public static ServiceError Server(string message, int statusCode = 0) =>
            new ServiceError(ServiceErrorCategory.Server, message, statusCode);
        public static ServiceError Domain(string message, int statusCode = 0) =>
            new ServiceError(ServiceErrorCategory.Domain, message, statusCode);

        public override string ToString() => $"[{Category}] {Message} (HTTP {StatusCode})";
    }
}

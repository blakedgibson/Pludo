using System;

namespace Pludo.Services.Core
{
    public readonly struct ServiceResult<T>
    {
        public bool IsSuccess { get; }
        public T Value { get; }
        public ServiceError Error { get; }

        private ServiceResult(bool ok, T value, ServiceError error)
        {
            IsSuccess = ok;
            Value = value;
            Error = error;
        }

        public static ServiceResult<T> Ok(T value) =>
            new ServiceResult<T>(true, value, default);

        public static ServiceResult<T> Fail(ServiceError error) =>
            new ServiceResult<T>(false, default, error);

        public ServiceResult<TOut> Map<TOut>(Func<T, TOut> selector) =>
            IsSuccess
                ? ServiceResult<TOut>.Ok(selector(Value))
                : ServiceResult<TOut>.Fail(Error);
    }

    public readonly struct ServiceResult
    {
        public bool IsSuccess { get; }
        public ServiceError Error { get; }

        private ServiceResult(bool ok, ServiceError error)
        {
            IsSuccess = ok;
            Error = error;
        }

        public static ServiceResult Ok() =>
            new ServiceResult(true, default);

        public static ServiceResult Fail(ServiceError error) =>
            new ServiceResult(false, error);
    }
}

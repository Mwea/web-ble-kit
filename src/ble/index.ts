export {
	type ConnectionPool,
	type ConnectionPoolEvents,
	type ConnectionPoolOptions,
	createConnectionPool,
	MAX_BLE_CONNECTIONS,
} from "./connection-pool";
export {
	createOperationQueue,
	type OperationQueue,
	type OperationQueueOptions,
} from "./operation-queue";
export {
	type BLERetryOptions,
	connectWithRetry,
	type ReadOptions,
	type RetryOptions,
	readWithRetry,
	readWithTimeout,
	type StartNotificationsOptions,
	startNotifications,
	type WriteOptions,
	withRetry,
	writeWithRetry,
	writeWithTimeout,
} from "./transport";

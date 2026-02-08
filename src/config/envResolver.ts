/**
 * 环境变量解析（.env 加载与配置中的 ${VAR} 替换）
 *
 * 供 ConfigManager 在 loadEnvFile 与 mergeConfig 中调用。
 */

/** 可选 logger，用于未定义变量时的警告 */
export type EnvResolverLogger = { warn?: (msg: string) => void };

/**
 * 解析字符串中的 ${VAR_NAME}，优先 process.env，再 envVars
 */
export const resolveEnvVariables = (
    value: string,
    envVars: Map<string, string>,
    logger?: EnvResolverLogger
): string => {
    const envVarPattern = /\$\{([^}]+)\}/g;
    return value.replace(envVarPattern, (match, varName) => {
        let envValue = process.env[varName];
        if (envValue === undefined) {
            envValue = envVars.get(varName);
        }
        if (envValue !== undefined) {
            return envValue;
        }
        logger?.warn?.(`环境变量 ${varName} 未定义，保持原值: ${match}`);
        return match;
    });
};

/**
 * 递归解析配置对象中所有字符串的 ${VAR}
 */
export const resolveEnvInConfig = (
    obj: unknown,
    envVars: Map<string, string>,
    logger?: EnvResolverLogger
): unknown => {
    if (typeof obj === 'string') {
        return resolveEnvVariables(obj, envVars, logger);
    }
    if (Array.isArray(obj)) {
        return obj.map((item) => resolveEnvInConfig(item, envVars, logger));
    }
    if (obj !== null && typeof obj === 'object') {
        const resolved: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(obj)) {
            resolved[key] = resolveEnvInConfig(val, envVars, logger);
        }
        return resolved;
    }
    return obj;
};

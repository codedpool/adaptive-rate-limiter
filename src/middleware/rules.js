/**
 * Resolve which rule applies to a request: a route-specific rule if one is
 * registered, otherwise the default. Route keys are `"<METHOD> <routePattern>"`,
 * e.g. `"POST /login"`. Returning `null` means "do not rate limit this route".
 *
 * @param {object} opts
 * @param {object} opts.defaultRule
 * @param {Record<string, object|null>} [opts.routes]
 */
export function makeRuleResolver({ defaultRule, routes = {} }) {
  return (req) => {
    const pattern = req.routeOptions?.url || req.route?.path || req.url;
    const routeKey = `${req.method} ${pattern}`;
    if (Object.prototype.hasOwnProperty.call(routes, routeKey)) return routes[routeKey];
    return defaultRule;
  };
}

/** Build the default hybrid rule from the app config block. */
export function defaultRuleFromConfig(cfg) {
  return {
    strategy: 'hybrid',
    limit: cfg.limit,
    windowMs: cfg.windowMs,
    burst: cfg.burst,
  };
}

export async function resolve(specifier, context, next) {
  if (specifier === "apache-arrow") {
    return next("apache-arrow-17", context);
  }

  return next(specifier, context);
}

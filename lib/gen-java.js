/**
 * Contract → Java client generator.
 *
 * Emits a dependency-light client: `RestClient` from `spring-web` plus Jackson
 * annotations on the DTO records. No `@Component` and no Spring context — the
 * constructor takes a base URL, so the class drops into any Spring or plain Java
 * project that already has `spring-web` and Jackson on the classpath.
 */

import { escapeJava, toCamel, toPackageSegments, toPascal } from './naming.js'

const JSON_NODE = { text: 'JsonNode', imports: ['com.fasterxml.jackson.databind.JsonNode'] }

/** Java spelling of a neutral type plus the imports it needs. */
export function javaTypeOf(type, models = new Set(), modelPackage) {
  switch (type?.kind) {
    case 'scalar': {
      switch (type.name) {
        case 'string': return { text: 'String', imports: [] }
        case 'int': return { text: 'Long', imports: [] }
        case 'double': return { text: 'Double', imports: [] }
        case 'boolean': return { text: 'Boolean', imports: [] }
        case 'decimal': return { text: 'BigDecimal', imports: ['java.math.BigDecimal'] }
        case 'datetime': return { text: 'Instant', imports: ['java.time.Instant'] }
        case 'date': return { text: 'LocalDate', imports: ['java.time.LocalDate'] }
        case 'time': return { text: 'LocalTime', imports: ['java.time.LocalTime'] }
        case 'uuid': return { text: 'UUID', imports: ['java.util.UUID'] }
        case 'bytes': return { text: 'byte[]', imports: [] }
        case 'void': return { text: 'void', imports: [] }
        default: return JSON_NODE
      }
    }
    case 'list': {
      const inner = javaTypeOf(type.of, models, modelPackage)
      return { text: `List<${inner.text}>`, imports: ['java.util.List', ...inner.imports] }
    }
    case 'map': {
      const inner = javaTypeOf(type.of, models, modelPackage)
      return { text: `Map<String, ${inner.text}>`, imports: ['java.util.Map', ...inner.imports] }
    }
    case 'ref': {
      const name = toPascal(type.name)
      if (!models.has(name)) return JSON_NODE
      return {
        text: name,
        imports: modelPackage === undefined ? [] : [`${modelPackage}.${name}`],
      }
    }
    default: return JSON_NODE
  }
}

/** Render a sorted import block. */
function importBlock(fqcns) {
  if (fqcns.size === 0) return ''
  return `${[...fqcns].sort().map(name => `import ${name};`).join('\n')}\n\n`
}

/** Spring `RestClient` call method for an HTTP verb. */
function restMethod(verb) {
  switch (verb) {
    case 'GET': return 'get'
    case 'POST': return 'post'
    case 'PUT': return 'put'
    case 'DELETE': return 'delete'
    case 'PATCH': return 'patch'
    default: return 'get'
  }
}

/** First successful declared response, falling back to the first response. */
function successType(operation) {
  const candidates = operation.responses.filter(response => response.status >= 200 && response.status < 300)
  const chosen = candidates[0] ?? operation.responses[0]
  return chosen?.type ?? { kind: 'scalar', name: 'json' }
}

/** Emit one client method; returns its source and the imports it adds. */
function emitOperation(operation, models, modelPackage) {
  const imports = new Set()
  const methodName = toCamel(operation.id)
  const signature = []

  for (const param of operation.params) {
    const java = javaTypeOf(param.type, models, modelPackage)
    for (const name of java.imports) imports.add(name)
    signature.push(`${java.text} ${toCamel(param.name)}`)
  }
  if (operation.requestBody !== undefined) {
    const java = javaTypeOf(operation.requestBody, models, modelPackage)
    for (const name of java.imports) imports.add(name)
    signature.push(`${java.text} payload`)
  }

  const returnType = successType(operation)
  const isVoid = returnType.kind === 'scalar' && returnType.name === 'void'
  const javaReturn = javaTypeOf(returnType, models, modelPackage)
  for (const name of javaReturn.imports) imports.add(name)

  const pathVars = operation.params.filter(param => param.in === 'path')
  const queryParams = operation.params.filter(param => param.in === 'query')
  const lines = []
  const doc = operation.summary.trim().replace(/\*\//g, '*\\/')
  lines.push(`  /** \`${operation.method} ${operation.path}\`${doc.length > 0 ? ` - ${doc}` : ''} */`)
  const streamReturn = operation.streaming === true
  lines.push(`  public ${streamReturn ? 'java.io.InputStream' : isVoid ? 'void' : javaReturn.text} ${methodName}(${signature.join(', ')}) {`)

  if (streamReturn) {
    // A streamed body is handed back as it arrives: reading it into a String would buffer the
    // whole event stream and defeat the point.
    const method = operation.method.toLowerCase()
    const pathArgs = pathVars.map(param => toCamel(param.name)).join(', ')
    const call = pathArgs.length === 0
      ? `http.${method}().uri("${escapeJava(operation.path)}")`
      : `http.${method}().uri("${escapeJava(operation.path)}", ${pathArgs})`
    if (queryParams.length > 0) {
      lines.push(`    // query parameters are not applied on a streaming call; add them at the call site`)
    }
    lines.push(`    return ${call}`)
    lines.push('        .retrieve()')
    lines.push('        .body(java.io.InputStream.class);')
    lines.push('  }')
    return { text: lines.join('\n'), imports }
  }
  if (operation.method === 'HEAD' || operation.method === 'OPTIONS') {
    lines.push(`    throw new UnsupportedOperationException("${operation.method} is not generated; call the endpoint with a configured RestClient");`)
    lines.push('  }')
    return { text: lines.join('\n'), imports }
  }

  let uriExpression
  if (pathVars.length === 0 && queryParams.length === 0) {
    uriExpression = `.uri("${escapeJava(operation.path)}")`
  } else {
    const inner = [`        builder.path("${escapeJava(operation.path)}");`]
    for (const param of queryParams) {
      const javaName = toCamel(param.name)
      if (param.required && param.default === undefined) {
        inner.push(`        builder.queryParam("${escapeJava(param.name)}", ${javaName});`)
      } else {
        inner.push(`        if (${javaName} != null) builder.queryParam("${escapeJava(param.name)}", ${javaName});`)
      }
    }
    if (pathVars.length === 0) {
      inner.push('        return builder.build();')
    } else {
      imports.add('java.util.Map')
      const entries = pathVars.map(param => `Map.entry("${escapeJava(param.name)}", ${toCamel(param.name)})`).join(', ')
      inner.push(`        return builder.build(Map.ofEntries(${entries}));`)
    }
    uriExpression = `.uri(builder -> {\n${inner.join('\n')}\n      })`
  }

  lines.push(`    ${isVoid ? '' : 'return '}http.${restMethod(operation.method)}()`)
  lines.push(`      ${uriExpression}`)
  if (operation.requestBody !== undefined) {
    lines.push('      .contentType(MediaType.APPLICATION_JSON)')
    lines.push('      .body(payload)')
    imports.add('org.springframework.http.MediaType')
  }
  if (isVoid) {
    lines.push('      .retrieve()')
    lines.push('      .toBodilessEntity();')
  } else if (returnType.kind === 'list' || returnType.kind === 'map') {
    imports.add('org.springframework.core.ParameterizedTypeReference')
    lines.push('      .retrieve()')
    lines.push(`      .body(new ParameterizedTypeReference<${javaReturn.text}>() {});`)
  } else {
    lines.push('      .retrieve()')
    lines.push(`      .body(${javaReturn.text}.class);`)
  }
  lines.push('  }')
  return { text: lines.join('\n'), imports }
}

/** Emit the client class source. */
function emitClient(contract, options, models) {
  const className = `${toPascal(options.serviceName)}Client`
  const imports = new Set([
    'org.springframework.web.client.RestClient',
    'org.springframework.http.client.JdkClientHttpRequestFactory',
    'java.net.http.HttpClient',
  ])
  const methods = []
  const modelPackage = `${options.packageName}.client.model`
  contract.operations.forEach((operation) => {
    const emitted = emitOperation(operation, models, modelPackage)
    for (const name of emitted.imports) imports.add(name)
    methods.push(emitted.text)
  })
  const header = [
    '/**',
    ` * Generated HTTP client for the \`${contract.kind}\` service \`${contract.name}\`.`,
    ' *',
    ' * <p>Do not edit: regenerate from the bridge contract instead.',
    ` * <p>Routes: ${contract.operations.length}. Models: ${contract.models.length}.`,
    ' */',
  ].join('\n')
  const content = [
    `package ${options.packageName}.client;`,
    '',
    importBlock(imports),
    header,
    `public class ${className} {`,
    '',
    '  private final RestClient http;',
    '',
    `  /**`,
    `   * @param baseUrl service root, for example {@code ${escapeJava(options.baseUrl)}}`,
    '   *',
    '   * <p>HTTP/1.1 is pinned because the JDK client otherwise offers a cleartext',
    '   * HTTP/2 upgrade ({@code Upgrade: h2c}); lightweight Python servers then see an',
    '   * upgraded connection and drop the request body.',
    '   */',
    `  public ${className}(String baseUrl) {`,
    '    HttpClient jdk = HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build();',
    '    this.http = RestClient.builder()',
    '        .baseUrl(baseUrl)',
    '        .requestFactory(new JdkClientHttpRequestFactory(jdk))',
    '        .build();',
    '  }',
    '',
    '  /** @param http a caller-configured client, for example with a filter or timeout */',
    `  public ${className}(RestClient http) {`,
    '    this.http = http;',
    '  }',
    '',
    ...methods.map(method => `${method}\n`),
    '}',
    '',
  ].join('\n')
  return { className, content }
}

/** Emit one DTO record; `undefined` when the model has no fields. */
function emitModel(model, packageName, modelNames) {
  if (model.fields.length === 0) return undefined
  const imports = new Set([
    'com.fasterxml.jackson.annotation.JsonIgnoreProperties',
    'com.fasterxml.jackson.annotation.JsonProperty',
  ])
  const components = []
  for (const field of model.fields) {
    const java = javaTypeOf(field.type, modelNames)
    for (const name of java.imports) imports.add(name)
    components.push(`    @JsonProperty("${escapeJava(field.name)}") ${java.text} ${toCamel(field.name)}`)
  }
  return [
    `package ${packageName}.client.model;`,
    '',
    importBlock(imports),
    '/**',
    ` * Generated from contract model \`${model.name}\`${model.table ? ` (table \`${model.table}\`)` : ''}.`,
    ' *',
    ' * <p>Do not edit: regenerate from the bridge contract instead.',
    ' */',
    '@JsonIgnoreProperties(ignoreUnknown = true)',
    `public record ${toPascal(model.name)}(`,
    components.join(',\n'),
    ') {',
    '}',
    '',
  ].join('\n')
}

/**
 * Generate the Java client sources for a contract.
 *
 * @returns files relative to the output directory, plus generated identities.
 */
export function generateJavaClient(contract, options) {
  const serviceName = options.serviceName ?? contract.name
  const packageName = options.packageName
    ?? `com.example.${toPackageSegments(serviceName).join('.')}.bridge`
  const packagePath = packageName.split('.').join('/')
  const modelNames = new Set(contract.models.map(model => toPascal(model.name)))
  const baseUrl = options.baseUrl ?? contract.baseUrl
  const files = []
  const notes = []

  const client = emitClient(contract, { serviceName, packageName, baseUrl }, modelNames)
  files.push({ path: `src/main/java/${packagePath}/client/${client.className}.java`, content: client.content })

  for (const model of contract.models) {
    if (model.kind === 'union') {
      files.push({ path: `src/main/java/${packagePath}/client/model/${toPascal(model.name)}.java`, content: emitJavaUnion(model, `${packageName}.client`) })
      continue
    }
    if (model.kind === 'enum') {
      files.push({ path: `src/main/java/${packagePath}/client/model/${toPascal(model.name)}.java`, content: emitJavaEnum(model, `${packageName}.client`) })
      continue
    }
    const content = emitModel(model, packageName, modelNames)
    if (content === undefined) {
      notes.push(`model \`${model.name}\` has no fields and was skipped`)
      continue
    }
    files.push({ path: `src/main/java/${packagePath}/client/model/${toPascal(model.name)}.java`, content })
  }

  const errorBodies = renderErrorBodies(contract, packageName)
  if (errorBodies !== undefined) files.push(errorBodies)

  files.push({ path: 'README-BRIDGE.md', content: renderReadme(contract, { packageName, className: client.className, baseUrl }) })
  return { files, notes, packageName, className: client.className }
}

import { enumConstant } from './ir.js'

/**
 * A Java enum whose wire form is the contract value, not the constant name.
 *
 * The project's Jackson uses SNAKE_CASE, so constant names and wire values differ; `@JsonValue`
 * keeps the mapping explicit instead of relying on a naming strategy.
 */
export function emitJavaEnum(model, packageName) {
  const name = toPascal(model.name)
  const constants = model.values.map(value => `    ${enumConstant(value)}("${value}")`).join(',\n')
  return [
    `package ${packageName}.model;`, '',
    'import com.fasterxml.jackson.annotation.JsonValue;', '',
    `public enum ${name} {`,
    `${constants};`, '',
    '    private final String wire;', '',
    `    ${name}(String wire) { this.wire = wire; }`, '',
    '    @JsonValue',
    '    public String wireName() { return wire; }',
    '}', '',
  ].join('\n')
}

/**
 * A decoder for declared error bodies.
 *
 * The generated client calls with `RestClient`, which throws `RestClientResponseException` on
 * a non-2xx reply and carries the raw body. Declaring the body type per status lets a caller
 * turn that into a model instead of parsing strings.
 */
function renderErrorBodies(contract, packageName) {
  const byStatus = new Map()
  for (const operation of contract.operations ?? []) {
    for (const error of operation.errors ?? []) {
      if (error.type?.kind !== 'ref') continue
      const type = toPascal(error.type.name)
      byStatus.set(error.status, byStatus.has(error.status) ? null : type)
    }
  }
  const entries = [...byStatus.entries()].filter(([, type]) => type !== null && type !== undefined)
  if (entries.length === 0) return undefined
  const imports = [...new Set(entries.map(([, type]) => type))].sort()
  const mapLines = entries.map(([status, type]) => `            Map.entry(${status}, ${type}.class)`).join(',\n')
  const content = [
    `package ${packageName}.client.model;`, '',
    'import com.fasterxml.jackson.databind.ObjectMapper;',
    'import org.springframework.web.client.RestClientException;',
    'import org.springframework.web.client.RestClientResponseException;', '',
    'import java.io.IOException;',
    'import java.util.Map;', '',
    '/**',
    ' * Decodes declared error bodies, by HTTP status.',
    ' *',
    ' * <p>Generated from the contract: each entry names the model the service returns for that',
    ' * status, so a caller can turn a transport failure into a typed value.',
    ' */',
    'public final class ErrorBodies {', '',
    '    private static final ObjectMapper MAPPER = new ObjectMapper();', '',
    '    private static final Map<Integer, Class<?>> TYPES = Map.ofEntries(',
    mapLines,
    '    );', '',
    '    private ErrorBodies() {', '    }', '',
    '    /** The model declared for this status, or null when the contract declares none. */',
    '    public static Class<?> typeFor(int status) {',
    '        return TYPES.get(status);',
    '    }', '',
    '    /** Decode the response body into the declared type, or null when absent or unparseable. */',
    '    public static <T> T decode(RestClientException error, Class<T> type) {',
    '        if (!(error instanceof RestClientResponseException response)) {',
    '            return null;',
    '        }',
    '        String body = response.getResponseBodyAsString();',
    '        if (body == null || body.isBlank()) {',
    '            return null;',
    '        }',
    '        try {',
    '            return MAPPER.readValue(body, type);',
    '        } catch (IOException ignored) {',
    '            return null;',
    '        }',
    '    }', '',
    '    /** Decode with the type the contract declares for this failure, if any. */',
    '    public static Object decode(RestClientException error) {',
    '        if (!(error instanceof RestClientResponseException response)) {',
    '            return null;',
    '        }',
    '        Class<?> type = typeFor(response.getStatusCode().value());',
    '        return type == null ? null : decode(error, type);',
    '    }', '',
    '}', '',
  ].join('\n')
  return { path: `src/main/java/${packageName.replace(/\./g, '/')}/client/model/ErrorBodies.java`, content }
}

/** A discriminated union: one interface, with Jackson selecting the variant by tag. */
export function emitJavaUnion(model, packageName) {
  const name = toPascal(model.name)
  return [
    `package ${packageName}.model;`, '',
    'import com.fasterxml.jackson.annotation.JsonTypeInfo;', '',
    '/**',
    ` * Discriminated union \`${name}\`, selected by the \`${model.discriminator}\` property.`,
    ' *',
    ` * <p>Variants: ${model.variants.map(variant => `${toPascal(variant.name)} (${variant.tag})`).join(', ')}.`,
    ' */',
    `@JsonTypeInfo(use = JsonTypeInfo.Id.NAME, include = JsonTypeInfo.As.PROPERTY, property = "${model.discriminator}", visible = true)`,
    `public interface ${name} {`,
    '}', '',
  ].join('\n')
}

/** Integration notes for the generated Java client. */
function renderReadme(contract, options) {
  const models = contract.models.map(model => toPascal(model.name))
  return `# Java client for \`${contract.name}\`

Generated from a \`${contract.kind}\` bridge contract: ${contract.operations.length} route(s), ${contract.models.length} model(s).

## Requirements

- Java 17+
- \`spring-web\` 6.1 or newer (for \`RestClient\`)
- Jackson \`jackson-databind\` (for the DTO records)

A Spring Boot project has both as soon as \`spring-boot-starter-web\` is present; take
the versions from your Spring Boot BOM rather than pinning them here.

## Usage

\`\`\`java
${options.className} client = new ${options.className}("${options.baseUrl}");
// share an already configured client instead:
// ${options.className} client = new ${options.className}(RestClient.builder().baseUrl("${options.baseUrl}").build());
\`\`\`

## Routes

| Method | Path | Operation | Summary |
| --- | --- | --- | --- |
${contract.operations.map(operation => `| ${operation.method} | \`${operation.path}\` | \`${toCamel(operation.id)}\` | ${operation.summary && operation.summary.trim().length > 0 ? operation.summary.trim() : '—'} |`).join('\n')}

## Generated models

${models.length === 0 ? '_This contract declares no models._' : models.map(name => `- \`${options.packageName}.client.model.${name}\``).join('\n')}

## Wire behaviour

- Non-2xx responses throw \`RestClientException\`; add \`defaultStatusHandler\` on the
  \`RestClient\` to turn error bodies into domain exceptions.
- Optional query parameters are only sent when they are not \`null\`.
- DTO records ignore unknown JSON properties, so adding a field on the producer side
  does not break existing callers.
`
}

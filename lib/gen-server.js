/**
 * Server skeleton generation: turn a contract into the producer side.
 *
 * The client generators cover the consumer half of a bridge. This completes the loop: from
 * the same contract it emits a Spring MVC interface (annotations on an interface are enough
 * for `@RestController` implementations) and a FastAPI router stub, so both sides can be
 * written against one declared surface instead of one being reverse-engineered.
 *
 * @module polyglot-bridge/gen-server
 */

import { VOID_TYPE, describeType, enumConstant } from './ir.js'
import { emitJavaEnum, emitJavaUnion } from './gen-java.js'
import { toCamel, toPascal, toSnake } from './naming.js'

/** Java type of a neutral type, boxed when usable as a generic argument. */
function javaType(type) {
  switch (type.kind) {
    case 'list': return `List<${javaTypeOf(type.of, true)}>`
    case 'map': return `Map<String, ${javaTypeOf(type.of, true)}>`
    case 'ref': return toPascal(type.name)
    default: break
  }
  switch (type.name) {
    case 'string': return 'String'
    case 'int': return 'int'
    case 'double': return 'double'
    case 'decimal': return 'BigDecimal'
    case 'boolean': return 'boolean'
    case 'datetime': return 'OffsetDateTime'
    case 'date': return 'LocalDate'
    case 'time': return 'LocalTime'
    case 'uuid': return 'UUID'
    case 'bytes': return 'byte[]'
    case 'void': return 'void'
    case 'json': return 'JsonNode'
    default: return 'Object'
  }
}

/** Same mapping, but boxed for positions where primitives are invalid. */
function javaTypeOf(type, boxed) {
  const plain = javaType(type)
  if (!boxed) return plain
  return ({ int: 'Integer', double: 'Double', boolean: 'Boolean' })[plain] ?? plain
}

/** Python type annotation of a neutral type. */
function pythonType(type) {
  switch (type.kind) {
    case 'list': return `list[${pythonType(type.of)}]`
    case 'map': return `dict[str, ${pythonType(type.of)}]`
    case 'ref': return toPascal(type.name)
    default: break
  }
  switch (type.name) {
    case 'string': return 'str'
    case 'int': return 'int'
    case 'double':
    case 'decimal': return 'float'
    case 'boolean': return 'bool'
    case 'datetime': return 'datetime'
    case 'date': return 'date'
    case 'time': return 'time'
    case 'uuid': return 'UUID'
    case 'bytes': return 'bytes'
    case 'void': return 'None'
    default: return 'Any'
  }
}

/** Return type of an operation: the first 2xx response, else the first one. */
function returnType(operation) {
  const responses = operation.responses ?? []
  const success = responses.filter(response => response.status >= 200 && response.status < 300)
  const chosen = success.length > 0 ? success[0] : responses[0]
  return chosen?.type ?? VOID_TYPE
}

/** Whether any operation uses a type that needs the Jackson node import. */
function needsJsonNode(contract) {
  const types = [...(contract.operations ?? []).flatMap(operation => [
    ...operation.params.map(param => param.type),
    ...(operation.requestBody ? [operation.requestBody] : []),
    ...operation.responses.map(response => response.type),
  ])]
  const walk = type => (type.kind === 'list' || type.kind === 'map' ? walk(type.of) : type.name === 'json')
  return types.some(walk)
}

const SPRING = {
  GET: ['GetMapping', ''],
  POST: ['PostMapping', ''],
  PUT: ['PutMapping', ''],
  PATCH: ['PatchMapping', ''],
  DELETE: ['DeleteMapping', ''],
  HEAD: ['HeadMapping', ''],
  OPTIONS: ['OptionsMapping', ''],
}

/** Spring MVC interface plus the records its signatures reference. */
export function generateJavaServer(contract, options = {}) {
  const service = toPascal(options.serviceName ?? contract.name ?? 'service')
  const packageName = options.packageName ?? `com.example.${toSnake(service).replace(/_/g, '')}.bridge`
  const files = []

  const imports = new Set([
    'java.util.List',
    'java.util.Map',
    'java.math.BigDecimal',
    'java.time.LocalDate',
    'java.time.LocalTime',
    'java.time.OffsetDateTime',
    'java.util.UUID',
    'org.springframework.web.bind.annotation.*',
    'org.springframework.http.HttpStatus',
    'org.springframework.web.bind.annotation.ResponseStatus',
  ])
  if (needsJsonNode(contract)) imports.add('com.fasterxml.jackson.databind.JsonNode')
  // Decided before the interface is assembled: the import block is already written by the time the
  // per-operation loop runs.
  if ((contract.operations ?? []).some(operation => operation.requestContentType === 'multipart/form-data')) {
    imports.add('org.springframework.web.multipart.MultipartFile')
  }
  if ((contract.models ?? []).length > 0) imports.add(`${packageName}.model.*`)

  const lines = []
  lines.push(`package ${packageName}.api;`, '')
  for (const entry of [...imports].sort()) lines.push(`import ${entry};`)
  lines.push('', '/**')
  lines.push(` * Producer side of the ${service} bridge, generated from the contract.`)
  lines.push(' *')
  lines.push(' * <p>Implement this interface in a {@code @RestController}; the annotations define the')
  lines.push(' * wire surface, so an implementation that compiles is one the contract promises.')
  lines.push(' */')
  lines.push(`public interface ${service}Api {`, '')

  for (const operation of contract.operations ?? []) {
    const [annotation] = SPRING[operation.method] ?? ['RequestMapping', operation.method]
    const path = operation.path
    const status = returnTypeOfStatus(operation)
    if (status !== undefined) lines.push(`    @ResponseStatus(HttpStatus.${status})`)
    // Declared failures belong in the skeleton: an implementer must know which bodies the
    // contract promises. A Javadoc note is used rather than springdoc annotations, so the
    // generated interface compiles without an extra dependency.
    const errors = operation.errors ?? []
    if (errors.length > 0) {
      const described = errors.map(error => `${error.status} ${describeType(error.type)}`).join(', ')
      lines.push(`    /** Declared errors: ${described}. */`)
    }
    lines.push(`    @${annotation}("${path}")`)
    const params = []
    for (const param of operation.params ?? []) {
      const type = javaTypeOf(param.type, false)
      if (param.in === 'path') {
        params.push(`@PathVariable("${param.name}") ${type} ${toCamel(param.name)}`)
      } else if (param.in === 'query') {
        params.push(`@RequestParam(name = "${param.name}", required = ${param.required}) ${javaTypeOf(param.type, true)} ${toCamel(param.name)}`)
      } else {
        params.push(`@RequestHeader("${param.name}") ${type} ${toCamel(param.name)}`)
      }
    }
    if (operation.requestContentType === 'multipart/form-data' && operation.requestBody?.kind === 'ref') {
      // Spring binds each part with @RequestPart; a binary part is a MultipartFile.
      imports.add('org.springframework.web.multipart.MultipartFile')
      imports.add('org.springframework.web.bind.annotation.RequestPart')
      const parts = (contract.models ?? []).find(model => model.name === operation.requestBody.name)?.fields ?? []
      for (const part of parts) {
        const isFile = part.type?.kind === 'scalar' && part.type.name === 'bytes'
        const annotation = isFile ? 'MultipartFile' : javaType(part.type)
        params.push(`@RequestPart(value = "${part.name}", required = ${part.required}) ${annotation} ${toCamel(part.name)}`)
      }
    } else if (operation.requestBody !== undefined) {
      params.push(`@RequestBody ${javaType(operation.requestBody)} payload`)
    }
    const name = toCamel(operation.id ?? `${operation.method.toLowerCase()}_${path}`)
    lines.push(`    ${javaType(returnType(operation))} ${name}(${params.join(', ')});`, '')
  }
  if (lines[lines.length - 1] === '') lines.pop()
  lines.push('}', '')
  files.push({ path: `src/main/java/${packageName.replace(/\./g, '/')}/api/${service}Api.java`, content: lines.join('\n') })
  for (const model of contract.models ?? []) {
    if (model.kind === 'union') {
      files.push({
        path: `src/main/java/${packageName.replace(/\./g, '/')}/model/${toPascal(model.name)}.java`,
        content: emitJavaUnion(model, packageName),
      })
      continue
    }
    if (model.kind === 'enum') {
      files.push({
        path: `src/main/java/${packageName.replace(/\./g, '/')}/model/${toPascal(model.name)}.java`,
        content: emitJavaEnum(model, packageName),
      })
      continue
    }
    const body = model.fields.map(field => {
      const annotation = `@JsonProperty("${field.name}")`
      return `        ${annotation} ${javaTypeOf(field.type, true)} ${toCamel(field.name)}`
    })
    files.push({
      path: `src/main/java/${packageName.replace(/\./g, '/')}/model/${toPascal(model.name)}.java`,
      content: [
        `package ${packageName}.model;`, '',
        'import com.fasterxml.jackson.annotation.JsonProperty;',
        'import java.math.BigDecimal;',
        'import java.time.LocalDate;',
        'import java.time.LocalTime;',
        'import java.time.OffsetDateTime;',
        'import java.util.List;',
        'import java.util.Map;',
        'import java.util.UUID;', '',
        `public record ${toPascal(model.name)}(`,
        body.join(',\n'),
        ') { }', '',
      ].join('\n'),
    })
  }
  return { files, className: `${service}Api`, moduleName: packageName }
}

/** Spring status constant for a non-200 declared success, when there is one. */
function returnTypeOfStatus(operation) {
  const success = (operation.responses ?? []).filter(response => response.status >= 200 && response.status < 300)
  if (success.length === 0) return undefined
  const status = success[0].status
  if (status === 200) return undefined
  const names = { 201: 'CREATED', 202: 'ACCEPTED', 204: 'NO_CONTENT' }
  return names[status]
}

/** FastAPI router stub plus pydantic models. */
export function generatePythonServer(contract, options = {}) {
  const service = toSnake(options.serviceName ?? contract.name ?? 'service')
  const models = contract.models ?? []
  const files = []

  const modelLines = ['"""Contract models. Field names follow the wire format."""', '', 'from __future__ import annotations', '']
  const modelImports = new Set(['datetime', 'date', 'time', 'typing.Any', 'uuid.UUID', 'pydantic.BaseModel'])
  if (models.some(model => model.fields.some(field => field.type.kind === 'list' || field.type.kind === 'map'))) {
    modelImports.add('typing.Optional')
  }
  for (const entry of [...modelImports].sort()) {
    if (entry === 'datetime') modelLines.push('from datetime import datetime')
    else if (entry === 'date') modelLines.push('from datetime import date')
    else if (entry === 'time') modelLines.push('from datetime import time')
    else if (entry === 'typing.Any') modelLines.push('from typing import Any')
    else if (entry === 'typing.Optional') modelLines.push('from typing import Optional')
    else if (entry === 'uuid.UUID') modelLines.push('from uuid import UUID')
    else modelLines.push('from pydantic import BaseModel')
  }
  modelLines.push('')
  if (models.some(model => model.kind === 'enum')) modelLines.push('from enum import Enum', '')
  for (const model of models) {
    if (model.kind === 'union') {
      modelLines.push('', `${toPascal(model.name)} = ${model.variants.map(variant => toPascal(variant.name)).join(' | ') || 'Any'}`)
      continue
    }
    if (model.kind === 'enum') {
      modelLines.push('', `class ${toPascal(model.name)}(str, Enum):`)
      for (const value of model.values ?? []) {
        modelLines.push(`    ${enumConstant(value)} = "${value}"`)
      }
      continue
    }
    modelLines.push('', `class ${toPascal(model.name)}(BaseModel):`)
    for (const field of model.fields) {
      const annotation = pythonType(field.type)
      const fallback = field.required ? '...' : 'None'
      const type = field.required ? annotation : `${annotation} | None`
      modelLines.push(`    ${toSnake(field.name)}: ${type} = ${fallback}`)
    }
  }
  modelLines.push('')
  files.push({ path: `${service}/models.py`, content: modelLines.join('\n') })

  const routerLines = [
    '"""Contract router. Replace each NotImplementedError with the implementation."""',
    '',
    'from __future__ import annotations',
    '',
    'from fastapi import APIRouter, Body, File, Form, Header, UploadFile',
    models.length > 0 ? `from .models import *  # noqa: F401,F403` : '',
    '',
    'router = APIRouter()',
    '',
  ]
  for (const operation of contract.operations ?? []) {
    const name = toSnake(operation.id ?? `${operation.method.toLowerCase()}_${operation.path}`)
    const params = []
    for (const param of operation.params ?? []) {
      if (param.in === 'path') params.push(`${toSnake(param.name)}: ${pythonType(param.type)}`)
      else if (param.in === 'query') {
        const type = pythonType(param.type)
        params.push(`${toSnake(param.name)}: ${param.required ? type : `${type} | None`} = ${param.required ? '...' : 'None'}`)
      } else if (param.in === 'header') {
        // Declaring the alias keeps the wire name exact: FastAPI would otherwise derive it from
        // the argument name and silently accept a different spelling.
        const type = pythonType(param.type)
        params.push(`${toSnake(param.name)}: ${param.required ? type : `${type} | None`} = Header(${param.required ? '...' : 'None'}, alias="${param.name}")`)
      }
    }
    if (operation.requestContentType === 'multipart/form-data' && operation.requestBody?.kind === 'ref') {
      // A multipart body is a set of parts: a binary part becomes an UploadFile, the rest Form
      // fields. Declaring it as a pydantic body would make FastAPI expect JSON instead.
      const parts = (contract.models ?? []).find(model => model.name === operation.requestBody.name)?.fields ?? []
      for (const part of parts) {
        const isFile = part.type?.kind === 'scalar' && part.type.name === 'bytes'
        const name = toSnake(part.name)
        const annotation = isFile ? 'UploadFile' : pythonType(part.type)
        const optional = part.required ? '' : ' | None'
        const call = isFile
          ? `File(${part.required ? '...' : 'None'}, alias="${part.name}")`
          : `Form(${part.required ? '...' : 'None'}, alias="${part.name}")`
        params.push(`${name}: ${annotation}${optional} = ${call}`)
      }
    } else if (operation.requestBody !== undefined) {
      params.push(`payload: ${pythonType(operation.requestBody)} = Body(...)`)
    }
    const result = returnType(operation)
    const returns = result.kind === 'scalar' && result.name === 'void' ? 'None' : pythonType(result)
    const errors = operation.errors ?? []
    if (errors.length > 0) {
      const described = errors.map(error => `${error.status} ${describeType(error.type)}`).join(', ')
      routerLines.push(`# Declared errors: ${described}.`)
    }
    routerLines.push(`@router.${operation.method.toLowerCase()}("${operation.path}", response_model=${returns === 'None' ? 'None' : returns})`)
    routerLines.push(`async def ${name}(${params.join(', ')}) -> ${returns}:`)
    routerLines.push(`    raise NotImplementedError("${operation.method} ${operation.path}")`)
    routerLines.push('')
  }
  files.push({ path: `${service}/router.py`, content: routerLines.join('\n') })
  files.push({ path: `${service}/__init__.py`, content: `"""${service} contract package."""\n` })
  const notes = []
  if ((contract.operations ?? []).some(operation => operation.requestContentType === 'multipart/form-data')) {
    notes.push('multipart routes need `python-multipart`: pip install python-multipart')
  }
  return { files, className: '', moduleName: service, notes }
}

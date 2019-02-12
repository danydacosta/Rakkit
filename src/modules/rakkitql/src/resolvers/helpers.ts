import { PubSubEngine } from "graphql-subscriptions";
import { ValidatorOptions } from "class-validator";

import { ParamMetadata } from "../metadata/definitions";
import { convertToType } from "../helpers/types";
import { validateArg } from "./validate-arg";
import { ResolverData, AuthChecker, AuthMode } from "../interfaces";
import { Middleware, MiddlewareClass } from "../interfaces/Middleware";
import { IOCContainer } from "../utils/container";
import { AuthMiddleware } from "../helpers/auth-middleware";
import { DecoratorStorage } from "@logic";
import { HandlerFunction, IContext, MiddlewareType } from "@types";

export async function getParams(
  params: ParamMetadata[],
  { root, args, context, info }: ResolverData<any>,
  globalValidate: boolean | ValidatorOptions,
  pubSub: PubSubEngine,
): Promise<any[]> {
  return Promise.all(
    params
      .sort((a, b) => a.index - b.index)
      .map(async paramInfo => {
        switch (paramInfo.kind) {
          case "args":
            return await validateArg(
              convertToType(paramInfo.getType(), args),
              globalValidate,
              paramInfo.validate,
            );
          case "arg":
            return await validateArg(
              convertToType(paramInfo.getType(), args[paramInfo.name]),
              globalValidate,
              paramInfo.validate,
            );
          case "context":
            if (paramInfo.propertyName) {
              return context[paramInfo.propertyName];
            }
            return context;
          case "root":
            const rootValue = paramInfo.propertyName ? root[paramInfo.propertyName] : root;
            if (!paramInfo.getType) {
              return rootValue;
            }
            return convertToType(paramInfo.getType(), rootValue);
          case "info":
            return info;
          case "pubSub":
            if (paramInfo.triggerKey) {
              return (payload: any) => pubSub.publish(paramInfo.triggerKey!, payload);
            }
            return pubSub;
        }
      }),
  );
}

export function applyAuthChecker(
  middlewares: MiddlewareType[],
  authMode: AuthMode,
  authChecker?: AuthChecker<any, any>,
  roles?: any[],
) {
  if (authChecker && roles) {
    middlewares.unshift(AuthMiddleware(authChecker, authMode, roles));
  }
}

export async function applyMiddlewares(
  container: IOCContainer,
  resolverData: ResolverData<any>,
  middlewares: MiddlewareType[],
  resolverHandlerFunction: (...params: any[]) => any,
): Promise<any> {
  let middlewaresIndex = -1;
  const beforeMiddlewares = [];
  const afterMiddlewares = [];
  middlewares.map((mw) => {
    const foundMiddleware = DecoratorStorage.Instance.Middlewares.get(mw);
    if (foundMiddleware) {
      switch (foundMiddleware.params.executionTime) {
        case "BEFORE":
          beforeMiddlewares.push(mw);
        break;
        case "AFTER":
          afterMiddlewares.push(mw);
        break;
      }
    } else {
      beforeMiddlewares.push(mw);
    }
  });
  const allMiddlewares = [
    ...beforeMiddlewares,
    resolverHandlerFunction,
    ...afterMiddlewares
  ];
  async function dispatchHandler(currentIndex: number): Promise<void> {
    if (currentIndex < allMiddlewares.length) {
      if (currentIndex <= middlewaresIndex) {
        throw new Error("next() called multiple times");
      }
      middlewaresIndex = currentIndex;
      let handlerFn: HandlerFunction;
      const currentMiddleware = allMiddlewares[currentIndex];
      // arrow function or class
      if (currentMiddleware.prototype !== undefined) {
        const middlewareClassInstance = container.getInstance(
          currentMiddleware as MiddlewareClass<any>,
          resolverData,
        );
        handlerFn = middlewareClassInstance.use.bind(middlewareClassInstance);
      } else {
        handlerFn = currentMiddleware as HandlerFunction;
      }
      const handlerParams: IContext = {
        root: resolverData.root,
        args: resolverData.args,
        info: resolverData.info,
        ...resolverData.context,
      };
      let nextResult: any;
      const result = await handlerFn(handlerParams, async () => {
        nextResult = await dispatchHandler(currentIndex + 1);
        return nextResult;
      });
      return result !== undefined ? result : nextResult;
    }
  }
  return dispatchHandler(0);
}
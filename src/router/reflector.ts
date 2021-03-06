import 'reflect-metadata';
import { Request, Response, Application as ExpressApp } from 'express';

import { Injector } from '../core/injector';
import { PolicyDescriptor } from '../core/policy';
import { CtorT } from '../core/ctor';
import { PolicyT } from '../core/policy';

import { Injectable } from '../decorators/services/injectable.decorator';
import { Name } from '../decorators/services/name.decorator';

import { ControllerMetadata, ControllerMetadataSym, ControllerRoutesSym } from '../metadata/router/controller';
import { RouteMetadata, RouteMetadataSym } from '../metadata/router/route';
import { RouterMetadata } from '../metadata/server/router';
import { PolicyMetadata, PolicyMetadataSym } from '../metadata/policies/policy';

import { Logger } from '../services/logger';
import { ErrorHandler } from '../services/error-handler';
import { RouterService } from '../services/router.service';

import { inhertitanceHierarchy } from '../util/inheritance-hierarchy';
import { joinRoutePaths } from '../util/join-route-paths';
import { wrapPromise } from '../util/wrap-promise';
import { HTTP_STATUS_NOT_FOUND, HTTP_STATUS_INTERNAL_SERVER_ERROR } from '../util/http-status-type';

import './extend-req-res';

export type RouteInterceptorNextFunction = () => Promise<void>;
export type RouteInterceptor = (req: Request, res: Response, next: RouteInterceptorNextFunction) => Promise<void>;

@Injectable({
    provide: {
        useCallback: function(injector: Injector, logger: Logger, errorHandler: ErrorHandler, routerMeta: RouterMetadata, _router: RouterService) {
            if (!routerMeta) return null;
            return new RouterReflector(injector, logger, errorHandler, routerMeta, _router);
        },
        deps: [Injector, Logger, ErrorHandler, RouterMetadata, RouterService],
        cache: true
    }
})
@Name('router')
export class RouterReflector {
    constructor(
        private injector: Injector,
        private logger: Logger,
        private errorHandler: ErrorHandler,
        private routerMeta: RouterMetadata,
        private _router: RouterService
    ) {
        this.registerRouteInterceptor(async (req, res, next) => {
            try {
                await next();
            }
            catch (e) {
                this.logger.error(e);
                if (!(<any>res).errorResult) throw e;
            }
        });
    }
    
    get router() {
        return this._router;
    }
    
    private controllersReflected: number = 0;
    private routesReflected: number = 0;
    reflectServerRoutes(app: ExpressApp) {
        this.logger.verbose(`Loading routes...`);
        this.reflectRoutes(this.routerMeta.controllers);
        app.use(this.router.expressRouter);
        this.logger.info(`${this.controllersReflected} controllers reflected.`);
        this.logger.info(`${this.routesReflected} routes reflected.`);
        this.logger.info(`Finished loading routes.`);
    }
    reflectRoutes(controllers: any[], parentControllers?: any[]) {
        parentControllers = parentControllers || [];
        
        this.logger.verbose(`in reflectRoutes; controllers=[${controllers && controllers.map(c => c.name || c)}]; parentControllers=[${parentControllers && parentControllers.map(c => c.name || c)}]`)
        for (let q = 0; q < controllers.length; q++) {
            this.reflectControllerRoutes(parentControllers, controllers[q]);
        }
    }
    
    private controllers: any = {};
    reflectControllerRoutes(parentControllers: any[], controllerFn: any) {
        if (this.controllers[controllerFn]) throw new Error(`A controller was passed to the router-reflector twice: ${controllerFn.name || controllerFn}.`);
        let controllerInst = this.controllers[controllerFn] = this.injector.resolveInjectable(controllerFn);
        let controllerProto = controllerFn.prototype;
        
        let meta: ControllerMetadata = Reflect.getOwnMetadata(ControllerMetadataSym, controllerProto);
        if (!meta) throw new Error(`Expecting class with @Controller decorator, could not reflect routes for ${controllerFn.name || controllerFn}.`);
        this.logger.verbose(`Reflecting routes for controller ${controllerFn.name || controllerFn}`);
        this.controllersReflected++;
        
        parentControllers = parentControllers || [];
        let parentMeta: ControllerMetadata[] = parentControllers.map(pc => Reflect.getOwnMetadata(ControllerMetadataSym, pc.prototype));
        if (parentMeta.some(pm => !pm)) throw new Error(`Failed to reflect parent controller metadata for controller: ${controllerFn.name || controllerFn}`);
        
        let routes = this.reflectRouteMeta(controllerProto);
        for (let q = 0; q < routes.length; q++) {
            let [routeFnName, routeMetaArr] = routes[q];
            for (let w = 0; w < routeMetaArr.length; w++) {
                let routeMeta = routeMetaArr[w];
                this.addRoute(parentMeta, controllerInst, routeFnName, meta, routeMeta);
            }
        }
        
        this.reflectRoutes(meta.controllers || [], [...parentControllers, controllerFn]);
    }
    
    private _interceptors: RouteInterceptor[] = [];
    /**
     * Registers a route interceptor which can be used to dynamically add or remove middleware.
     * In most cases, you should use a regular policy or middleware function.
     * Route interceptors are invoked AFTER middleware but BEFORE policies.
     * They are useful in cases where you have to control the manner in which the next interceptor is invoked,
     * or in cases where you have to execute code after a response has been sent rather than before.
     * @param interceptor The route interceptor to be invoked for every request
     */
    public registerRouteInterceptor(interceptor: RouteInterceptor) {
        this._interceptors.push(interceptor);
    }
    
    private reflectRouteMeta(controllerProto: any): [string, RouteMetadata[]][] {
        let hierarchy = inhertitanceHierarchy(controllerProto);
        this.logger.verbose('reflecting routes for inheritance hierarchy:', hierarchy.map(fn => fn.name || fn));
        let routeMeta: [string, RouteMetadata[]][] = [];
        for (let r = 0; r < hierarchy.length; r++) {
            let fn = hierarchy[r];
            let routeNames: string[] = Reflect.getOwnMetadata(ControllerRoutesSym, fn) || [];
            for (let q = 0; q < routeNames.length; q++) {
                let routeFnName: string = routeNames[q];
                let routeMetaArr: RouteMetadata[] = Reflect.getOwnMetadata(RouteMetadataSym, fn, routeFnName) || [];
                routeMeta.push([routeFnName, routeMetaArr]);
                //TODO: Ensure routes on parent classes are still accessible
            }
        }
        return routeMeta;
    }
    
    private addRoute(parentMeta: ControllerMetadata[], controller: any, routeFnName: string, controllerMeta: ControllerMetadata, routeMeta: RouteMetadata) {
        let controllerName = this.getControllerName(controller);
        let routeMethodName = `${controllerName}#${routeFnName}`;
        
        if (typeof routeMeta.method === 'undefined') throw new Error(`Failed to create route ${controller}.${routeFnName}. No method set!`);
        
        let pathPart = routeMeta.path;
        if (typeof controller.transformRoutePathPart === 'function') {
            pathPart = controller.transformRoutePathPart(routeFnName, pathPart) || pathPart;
        }
        let fullPath = joinRoutePaths(...[
            this.routerMeta.path,
            ...parentMeta.map(pm => pm.path || ''),
            controllerMeta.path || '',
            pathPart
        ]);
        if (controller.transformRoutePath) {
            fullPath = controller.transformRoutePath(routeFnName, fullPath) || fullPath;
        }
        
        let policyDescriptors = [
            ...(this.routerMeta.policies),
            ...this.getParentPolicyDescriptors(parentMeta),
            ...(controllerMeta.policies || []),
            ...(routeMeta.policies || [])
        ];
        if (typeof controller.transformRoutePolicies === 'function') {
            policyDescriptors = controller.transformRoutePolicies(routeFnName, fullPath, policyDescriptors) || policyDescriptors;
        }
        
        if (typeof controller.transformRoute === 'function') {
            let route = { routeFnName, fullPath, policyDescriptors };
            let result = controller.transformRoute(route);
            [routeFnName, fullPath, policyDescriptors] = [route.routeFnName, route.fullPath, route.policyDescriptors];
            if (typeof result === 'boolean' && !result) {
                this.logger.verbose(`... Skipping route ${routeFnName} (${routeMeta.method.toUpperCase()} ${fullPath})`);
                return;
            }
        }
        
        policyDescriptors = this.flattenPolicies(policyDescriptors);
        let policies = this.resolvePolicies(policyDescriptors);
        if (!controller[routeFnName]) throw new Error(`There is no route handler for ${controllerName}.${routeFnName}`);
        if (typeof controller[routeFnName] !== 'function') throw new Error(`The route handler for ${controllerName}.${routeFnName} is not a function`);
        let boundRoute = controller[routeFnName].bind(controller);
        
        this.logger.verbose(`& Adding route ${routeFnName} (${routeMeta.method.toUpperCase()} ${fullPath})`);
        this.routesReflected++;
        
        let addRouteFn = (<any>this.router.expressRouter)[routeMeta.method].bind(this.router.expressRouter);
        let fullRouterFn = this.createFullRouterFn(policies, boundRoute, routeMethodName);
        addRouteFn(fullPath, fullRouterFn);
    }
    private getControllerName(controller: any): string {
        if (!controller) {
            throw new Error(`Cannot extract name from falsey controller: ${controller}`);
        }
        else if (controller.constructor && controller.constructor.name) {
            return controller.constructor.name;
        }
        else if (controller.name) {
            return controller.name;
        }
        else return controller;
    }
    private getParentPolicyDescriptors(parentMeta: ControllerMetadata[]): PolicyDescriptor[] {
        let policies = [];
        for (let pm of parentMeta)
        {
            policies.push(...(pm.policies || []));
        }
        return policies;
    }
    private flattenPolicies(descriptors: PolicyDescriptor[]): PolicyDescriptor[] {
        let aggregate: PolicyDescriptor[] = [];
        this.flattenPolicies_recursive(descriptors, aggregate);
        return aggregate;
    }
    private flattenPolicies_recursive(descriptors: PolicyDescriptor[], aggregate: PolicyDescriptor[]) {
        for (let policy of descriptors) {
            if (this.isPolicyCtor(policy)) {
                let policyMeta: PolicyMetadata = Reflect.getOwnMetadata(PolicyMetadataSym, policy.prototype) || {};
                let nestedPolicies = policyMeta.policies;
                if (nestedPolicies) this.flattenPolicies_recursive(nestedPolicies, aggregate);
            }
            let found = false;
            for (let q = 0; q < aggregate.length; q++) {
                if (aggregate[q] === policy) {
                    found = true;
                    break;
                }
            }
            if (!found) aggregate.push(policy);
        }
    }
    private resolvePolicies(descriptors: PolicyDescriptor[]): [undefined | CtorT<PolicyT<any>>, { (req: Request, res: Response): Promise<any> }][] {
        return descriptors.map((desc): [undefined | CtorT<PolicyT<any>>, { (req: Request, res: Response): Promise<any> }] => {
            let key: undefined | CtorT<PolicyT<any>>;
            let fn: { (req: Request, res: Response): Promise<any> };
            if (this.isPolicyCtor(desc)) {
                key = desc;
                let val = this.injector.resolveInjectable(desc);
                if (!val) throw new Error(`Could not resolve dependency for policy: ${desc.name || desc}`);
                desc = val;
            }
            if (this.isPolicyT(desc)) {
                fn = desc.handle.bind(desc);
            }
            else {
                let handler = desc;
                fn = async function(req: Request, res: Response) {
                    return await wrapPromise(handler, req, res);
                }
            }
            return [key, fn];
        });
    }
    private isPolicyCtor(desc: PolicyDescriptor): desc is CtorT<PolicyT<any>> {
        if (this.isPolicyT(desc)) return false;
        let ctorFn = <CtorT<PolicyT<any>>>desc;
        return !!(ctorFn.prototype && ctorFn.prototype.handle);
    }
    private isPolicyT(desc: PolicyDescriptor): desc is PolicyT<any> {
        return !!(<PolicyT<any>>desc).handle;
    }
    
    unfinishedRoutes = 0;
    requestIndex = 0;
    private createFullRouterFn(policies: [undefined | CtorT<PolicyT<any>>, { (req: Request, res: Response): Promise<any> }][], boundRoute: any, routeMethodName: string) {
        let fullRouterFn = async function(this: RouterReflector, requestIndex: number, req: Request, res: Response) {
            this.logger.info(`{${requestIndex}} beginning request: ${req.url}`);
            this.logger.verbose(`{${requestIndex}} unfinishedRoutes: ${++this.unfinishedRoutes}`);
            let allResults: any[] = [];
            req.policyResults = this.createPolicyResultsFn(policies, allResults);
            let initialStatusCode = res.statusCode;
            for (let q = 0; q < policies.length; q++) {
                let policy = policies[q];
                let result: any;
                let policyCtor = policy[0];
                let policyName = (policyCtor && (policyCtor.name || policyCtor)) || '(undefined)';
                try {
                    this.logger.verbose(`{${requestIndex}} awaiting policy ${q+1}/${policies.length} (${policyName})`);
                    result = await policy[1](req, res);
                    this.logger.verbose(`{${requestIndex}} policy ${policyName} returned with result ${JSON.stringify(result)}`);
                }
                catch (e) {
                    this.logger.error(`{${requestIndex}} policy (${policyName}) threw an exception.`);
                    this.logger.error(e);
                    let errorResult: boolean | Promise<boolean> = this.errorHandler.handleRouteError(e, req, res);
                    if (typeof errorResult !== 'boolean' && typeof errorResult !== 'undefined' && errorResult !== null) errorResult = await errorResult;
                    if (res.statusCode === initialStatusCode) {
                        this.logger.error(`Error handler did not send a response. Serving 500 - Internal server error`);
                        res.status(HTTP_STATUS_INTERNAL_SERVER_ERROR);
                        res.send('Internal server error');
                        this.logger.verbose(`{${requestIndex}} ending request. unfinishedRoutes: ${--this.unfinishedRoutes}`);
                    }
                    if (!errorResult) throw e;
                    return;
                }
                allResults.push(result);
                if (res.statusCode !== initialStatusCode || res.headersSent) return;
            }
            
            this.logger.verbose(`{${requestIndex}} policies complete`);
            let failed = false;
            try {
                this.logger.verbose(`{${requestIndex}} calling route`);
                await boundRoute(req, res);
                this.logger.verbose(`{${requestIndex}} route complete`);
            }
            catch (e) {
                this.logger.error(`{${requestIndex}} route threw an exception. unfinishedRoutes: ${this.unfinishedRoutes}`);
                let errorResult: boolean | Promise<boolean> = this.errorHandler.handleRouteError(e, req, res);
                if (typeof errorResult !== 'boolean' && typeof errorResult !== 'undefined' && errorResult !== null) errorResult = await errorResult;
                if (initialStatusCode === res.statusCode) {
                    this.logger.error(`Error handler did not send a response. Serving 500 - Internal server error`);
                    res.status(HTTP_STATUS_INTERNAL_SERVER_ERROR);
                    res.send('Internal server error');
                }
                (<any>res).errorResult = errorResult;
                failed = true;
                throw e; //This ensures that the transaction is rolled back
            }
            finally {
                --this.unfinishedRoutes;
                if (!failed && res.statusCode === initialStatusCode && !res.headersSent) {
                    this.logger.error(`{${requestIndex}} route failed to send a response.`);
                    let errorResult: boolean | Promise<boolean> = this.errorHandler.handleNoRouteResponse(req, res);
                    if (typeof errorResult !== 'boolean' && typeof errorResult !== 'undefined' && errorResult !== null) errorResult = await errorResult;
                    if (initialStatusCode === res.statusCode) {
                        this.logger.error(`Error handler did not send a response. Serving 404 - Not Found`);
                        res.status(HTTP_STATUS_NOT_FOUND);
                        res.send(`Not found.`);
                    }
                }
                this.logger.verbose(`{${requestIndex}} ending request. unfinishedRoutes: ${this.unfinishedRoutes}`);  
            }
        };
        
        let self = this;
        return async function(req: Request, res: Response) {
            let requestIndex = ++self.requestIndex;
            req.requestIndex = requestIndex;
            req.routeMethodName = routeMethodName;
            
            let interceptors = [...self._interceptors];
            let interceptorCallbacks: RouteInterceptorNextFunction[] = [];
            let initialStatusCode = res.statusCode;
            for (let q = 0; q < interceptors.length; q++) {
                interceptorCallbacks.push(async () => {
                    if (res.statusCode !== initialStatusCode || res.headersSent) return;
                    await interceptors[q + 1](req, res, interceptorCallbacks[q + 1]);
                });
            }
            interceptors.push(async () => {
                await fullRouterFn.call(self, requestIndex, req, res);
            });
            await interceptors[0](req, res, interceptorCallbacks[0]);
        }
    }
    private createPolicyResultsFn(policies: [undefined | CtorT<PolicyT<any>>, { (req: Request, res: Response): Promise<any> }][], allResults: any[]) {
        let keys = policies.map(poli => poli[0]);
        return function(policyFn: CtorT<PolicyT<any>> | number) {
            if (typeof policyFn === 'number') return allResults[policyFn];
            for (let q = 0; q < keys.length; q++) {
                if (keys[q] === policyFn) return allResults[q];
            }
            return undefined;
        }
    }
}

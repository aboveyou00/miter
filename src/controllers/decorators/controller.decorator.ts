import { ControllerMetadata, ControllerMetadataSym, ControllerRoutesSym } from '../../router/metadata';
import { Injectable } from '../../inject';

export function Controller(meta: ControllerMetadata) {
   return function(controller: any) {
      Reflect.defineMetadata(ControllerMetadataSym, meta, controller.prototype);
      
      var routes: string[] = Reflect.getOwnMetadata(ControllerRoutesSym, controller.prototype) || [];
      Reflect.defineMetadata(ControllerRoutesSym, routes, controller.prototype);
      
      return Injectable()(controller);
   }
}

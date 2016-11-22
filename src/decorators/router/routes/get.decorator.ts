import { RouteMetadata } from '../../../metadata';
import { createRouteDecorator, RouteDecoratorFunc } from './route.decorator';

export function Get(meta: RouteMetadata | string): RouteDecoratorFunc {
    return createRouteDecorator(meta, 'get');
}

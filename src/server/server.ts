"use strict";

import * as express from 'express';
import config = require('config');
import * as Sequelize from 'sequelize';

import { Injector } from '../core';
import { ServerMetadata } from './metadata';
import { OrmReflector } from '../orm';
import { RouterReflector } from '../router';

import * as http from 'http';
var debug = require("debug")("express:server");

export class Server {
   constructor(private meta: ServerMetadata) {
      console.log("Initializing api-server...");
      this._app = express();
      this._injector = new Injector();
      
      console.log("  I just did this!");
      
      console.log("  Loading database configuration...");
      this.orm();
      
      console.log("  Loading routes...");
      this.routes();
      
      console.log("Serving");
   }
   
   private _app: express.Application;
   get app(): express.Application {
      return this._app;
   }
   
   private _injector: Injector;
   get injector(): Injector {
      return this._injector;
   }
   
   private ormReflector: OrmReflector;
   orm() {
      var name = config.get<string>('connections.db.name');
      var port = config.get<number>('connections.db.port');
      var user = config.get<string>('connections.db.user');
      var password = config.get<string>('connections.db.password');
      var host = config.get<string>('connections.db.host');
      var dialect = config.has('connections.db.dialect') ? config.get<string>('connections.db.dialect') : 'mysql';
      
      let sql = new Sequelize(name, user, password, {
         host: `${host}:${port}`,
         dialect: dialect
      });
      this.ormReflector = new OrmReflector(sql, this.injector);
      this.ormReflector.reflectModels(this.meta.models || []);
   }
   
   private routerReflector: RouterReflector;
   routes() {
      let router = express.Router();
      this.routerReflector = new RouterReflector(router, this.injector);
      this.routerReflector.reflectRoutes(this.meta.controllers || []);
      this.app.use(router);
   }
   
   private httpServer: http.Server;
   listen() {
      //create http server
      this.httpServer = http.createServer(this.app);
      
      //listen on provided ports
      this.httpServer.on("error", (err) => this.onError(err));
      this.httpServer.on("listening", () => this.onListening());
      this.httpServer.listen(this.meta.port);
   }
   private onError(error) {
      if (error.syscall !== "listen") {
         throw error;
      }
      
      var bind = (typeof this.meta.port === "string") ? `pipe ${this.meta.port}` : `port ${this.meta.port}`;
      
      // handle specific listen errors with friendly messages
      switch (error.code) {
      case "EACCES":
         console.error(`${bind} requires elevated privileges`);
         process.exit(1);
         break;
      case "EADDRINUSE":
         console.error(`${bind} is already in use`);
         process.exit(1);
         break;
      default:
         throw error;
      }
   }
   private onListening() {
      var addr = this.httpServer.address();
      var bind = (typeof addr === "string") ? `pipe ${addr}` : `port ${addr.port}`;
      debug(`Listening on ${bind}`);
   }
}
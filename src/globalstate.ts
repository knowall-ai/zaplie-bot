/// <reference path="./types/global.d.ts" />


export let currentUser: User;


export function setCurrentUser(user: User) {
  currentUser = user;
}

export function getCurrentUser(): User {
  return currentUser;
}
